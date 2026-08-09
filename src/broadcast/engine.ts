import { config } from './config.js';
import type { MarketLine, TraderLine } from './news/bulletin.js';

/**
 * Reads the market engine.
 *
 * The service README is explicit that video sits outside the engine and
 * consumes events, so this is the only seam: `GET /api/markets` for state and
 * the `/events` SSE stream for movement. The renderer never writes to the book.
 *
 * Two things the engine does not expose, and how they are handled:
 *
 *  - PRICE HISTORY comes from GET /api/markets/:id/history, which the engine
 *    added alongside its UI. Locally accumulated points are kept only as a
 *    fallback when that call fails, so a chart is never drawn from guesses.
 *  - AN ACCOUNT LIST. Accounts are fetched by id, so there is no roster to
 *    profile. Traders are learned from trade events as they appear, which means
 *    the karma segment has nothing to say until somebody trades — correct
 *    behaviour, since a balance nobody has used is not a story.
 */

const MAX_HISTORY = 120;

type Snapshot = {
  market: {
    id: string;
    question: string;
    status: string;
    closesAt: string;
    sourcePost?: { text?: string; authorHandle?: string };
  };
  priceYes: number;
  metrics?: { activityCount?: number; demoActivityCount?: number };
};

export class Engine {
  private history = new Map<string, number[]>();
  /** Keyed by userId; a TraderLine carries the display handle. */
  private traders = new Map<string, TraderLine>();
  private learning = new Set<string>();
  private volumes = new Map<string, number>();
  private recent: string[] = [];
  private newListings: string[] = [];
  /** Every market id ever observed; used to spot listings without trusting
   *  any single delivery path. */
  private knownIds = new Set<string>();
  private listingWatchPrimed = false;
  private swings: Array<{ marketId: string; question: string; from: number; to: number }> = [];
  private lastPrice = new Map<string, number>();
  private questions = new Map<string, string>();
  private es?: { close(): void };

  constructor(private readonly base = config.engineUrl) {}

  /** Real series from the engine. Falls back to locally observed prices. */
  private async fetchHistory(id: string): Promise<number[] | undefined> {
    const res = await fetch(`${this.base}/api/markets/${id}/history?limit=120`).catch(() => undefined);
    if (!res?.ok) return undefined;
    const body = (await res.json().catch(() => undefined)) as { points?: Array<{ priceYes: number }> } | undefined;
    // Guard the shape rather than trusting it: an un-awaited promise upstream
    // serialises to {}, and an unguarded .map here takes the whole server down.
    const raw = Array.isArray(body?.points) ? body.points : [];
    const pts = raw.map((p) => p?.priceYes).filter((n): n is number => Number.isFinite(n));
    return pts.length > 1 ? pts.slice(-MAX_HISTORY) : undefined;
  }

  async markets(): Promise<MarketLine[]> {
    const res = await fetch(`${this.base}/api/markets?limit=50`).catch(() => undefined);
    if (!res?.ok) return [];
    const body = (await res.json().catch(() => undefined)) as { markets?: Snapshot[] } | undefined;
    const snaps = body?.markets ?? [];

    const engineHistory = new Map<string, number[]>();
    await Promise.all(
      snaps.map(async (s) => {
        const h = await this.fetchHistory(s.market.id);
        if (h) engineHistory.set(s.market.id, h);
      }),
    );

    return snaps.map((s) => {
      const id = s.market.id;
      const price = s.priceYes;
      this.questions.set(id, s.market.question);

      const series = this.history.get(id) ?? [];
      if (series.length === 0 || series[series.length - 1] !== price) {
        series.push(price);
        if (series.length > MAX_HISTORY) series.shift();
        this.history.set(id, series);
      }

      return {
        id,
        question: s.market.question,
        price,
        // Volume in credits is summed from observed trade events; the tick
        // count comes from the snapshot's own activity metric, so the tape
        // reads as alive even for movement this process never witnessed.
        volume: Math.round(this.volumes.get(id) ?? 0),
        tradeCount: Number(s.metrics?.activityCount ?? 0),
        status: s.market.status,
        sourceHandle: s.market.sourcePost?.authorHandle ?? 'unknown',
        sourceClaim: s.market.sourcePost?.text,
        resolveBy: s.market.closesAt?.slice(0, 10),
        history: engineHistory.get(id) ?? [...series],
      };
    });
  }

  getTraders(): TraderLine[] {
    return [...this.traders.values()].sort((a, b) => b.credits - a.credits);
  }

  getRecent(): string[] {
    return this.recent;
  }

  takeSwing() {
    return this.swings.shift();
  }

  /** Consume the next market created since we started watching. */
  takeNewListing(): string | undefined {
    return this.newListings.shift();
  }

  private noteListing(marketId: string): void {
    if (!marketId || this.knownIds.has(marketId)) return;
    this.knownIds.add(marketId);
    if (!this.listingWatchPrimed) return; // the initial book is not news
    this.newListings.push(marketId);
    if (this.newListings.length > 5) this.newListings.shift();
  }

  /**
   * Poll-based listing watch: a light fetch of market ids, diffed against
   * everything seen so far. SSE announces listings too, but a broadcast that
   * exists to cover fresh tweets cannot depend on one delivery path — this
   * catches anything the stream misses within ten seconds. First call primes
   * the known set so a restart never treats the whole book as breaking news.
   */
  async pollListings(): Promise<void> {
    const res = await fetch(`${this.base}/api/markets?limit=50`).catch(() => undefined);
    if (!res?.ok) return;
    const body = (await res.json().catch(() => undefined)) as { markets?: Snapshot[] } | undefined;
    for (const s of body?.markets ?? []) this.noteListing(s.market.id);
    this.listingWatchPrimed = true;
  }

  private note(line: string) {
    if (!line || this.recent.includes(line)) return;
    this.recent.push(line);
    if (this.recent.length > 40) this.recent.shift();
  }

  /**
   * Bootstrap the trader roster from the public leaderboard, so the karma
   * segments have someone to profile before this process happens to witness
   * a trade. Live trades then keep individual balances fresh.
   */
  async loadRoster(): Promise<void> {
    const res = await fetch(`${this.base}/api/accounts`).catch(() => undefined);
    const body = (await res?.json().catch(() => undefined)) as
      | { accounts?: Array<{ xUserId?: string; handle?: string; karmaSeed?: number; availableBalance?: number }> }
      | undefined;
    for (const a of body?.accounts ?? []) {
      if (!a?.xUserId || !a.handle) continue;
      this.traders.set(String(a.xUserId), {
        handle: String(a.handle).replace(/^@/, ''),
        credits: Number(a.availableBalance ?? 0),
        seedCredits: Number(a.karmaSeed ?? a.availableBalance ?? 0),
      });
    }
  }

  /** Subscribe to the engine's SSE feed. Movement drives breaking interrupts. */
  connect(onLog: (m: string) => void = () => {}): void {
    const url = `${this.base}/events`;
    // Node 22 has EventSource behind a flag on some builds, so the stream is
    // read directly rather than depending on it being present.
    void (async () => {
      try {
        const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
        if (!res.ok || !res.body) {
          onLog(`events unavailable (HTTP ${res.status}) — running on polling only`);
          return;
        }
        onLog(`subscribed to ${url}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const chunk of parts) {
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            try {
              this.ingest(JSON.parse(dataLine.slice(5).trim()));
            } catch {
              /* not JSON; ignore */
            }
          }
        }
      } catch (err) {
        onLog(`events stream ended: ${err instanceof Error ? err.message : err}`);
      }
    })();
  }

  /**
   * A trade event carries only a userId; the face of the trader — handle,
   * karma seed, live balance — lives on the account. Fetched lazily per
   * trader and refreshed after every trade, so the karma board tracks P&L.
   */
  private async learnTrader(userId: string): Promise<void> {
    if (!userId || this.learning.has(userId)) return;
    this.learning.add(userId);
    try {
      const res = await fetch(`${this.base}/api/accounts/${encodeURIComponent(userId)}`).catch(() => undefined);
      const body = (await res?.json().catch(() => undefined)) as
        | { account?: { handle?: string; karmaSeed?: number; availableBalance?: number } }
        | undefined;
      const a = body?.account;
      if (!a?.handle) return;
      const prior = this.traders.get(userId);
      this.traders.set(userId, {
        handle: String(a.handle).replace(/^@/, ''),
        credits: Number(a.availableBalance ?? prior?.credits ?? 0),
        seedCredits: Number(a.karmaSeed ?? prior?.seedCredits ?? a.availableBalance ?? 0),
      });
    } finally {
      this.learning.delete(userId);
    }
  }

  private trackSwing(marketId: string, question: string, price: number): void {
    if (!Number.isFinite(price)) return;
    const prev = this.lastPrice.get(marketId);
    this.lastPrice.set(marketId, price);
    if (prev === undefined) return;
    // Coalesce per market: a contract that keeps moving updates its one pending
    // story rather than queueing a fresh interrupt per tick — and if it round
    // trips back under the threshold, there is no story any more.
    const pending = this.swings.find((s) => s.marketId === marketId);
    if (pending) {
      pending.to = price;
      if (Math.abs(pending.to - pending.from) < 0.08) {
        this.swings = this.swings.filter((s) => s !== pending);
      }
      return;
    }
    if (Math.abs(price - prev) >= 0.08) {
      this.swings.push({ marketId, question, from: prev, to: price });
      if (this.swings.length > 3) this.swings.shift();
    }
  }

  private ingest(event: any): void {
    const type = String(event?.type ?? '');
    const p = event?.payload ?? {};
    const marketId = String(event?.marketId ?? p.marketId ?? '');
    const question = this.questions.get(marketId) ?? marketId;

    if (type === 'market.created') {
      this.note(`New listing ${marketId}`);
      this.noteListing(marketId);
      return;
    }

    if (type === 'market.trade.executed') {
      // Payload shape is { trade, priceYes, priceNo } — the identity fields
      // live on the trade itself, not at the top level.
      const trade = p.trade ?? {};
      const price = Number(p.priceYes);
      const userId = String(trade.userId ?? '');
      const credits = Number(trade.credits);
      if (Number.isFinite(credits) && credits > 0) {
        this.volumes.set(marketId, (this.volumes.get(marketId) ?? 0) + credits);
      }
      const known = this.traders.get(userId)?.handle;
      void this.learnTrader(userId);
      this.note(
        `${known ? '@' + known : 'a trader'} ${trade.side === 'SELL' ? 'sold' : 'bought'} ${trade.outcome ?? '?'}${Number.isFinite(credits) ? ` for ${Math.round(credits)} credits` : ''} on ${question.slice(0, 60)}${Number.isFinite(price) ? ` — now ${(price * 100).toFixed(1)}%` : ''}`,
      );
      this.trackSwing(marketId, question, price);
      return;
    }

    // Background demo flow: anonymous, but it moves the book — so it feeds
    // swing detection (breaking interrupts) without inventing a trader.
    if (type === 'market.demo.pulse') {
      this.trackSwing(marketId, question, Number(p.priceAfter));
      return;
    }

    if (type === 'market.resolved') {
      this.note(`${marketId} resolved ${p.outcome ?? 'UNRESOLVABLE'}`);
    }
  }

  close(): void {
    this.es?.close();
  }
}
