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
};

export class Engine {
  private history = new Map<string, number[]>();
  private traders = new Map<string, TraderLine>();
  private recent: string[] = [];
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
        // The engine does not report volume or trade count on a snapshot; both
        // are counted from observed trade events instead of guessed.
        volume: 0,
        tradeCount: 0,
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

  private note(line: string) {
    if (!line || this.recent.includes(line)) return;
    this.recent.push(line);
    if (this.recent.length > 40) this.recent.shift();
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

  private ingest(event: any): void {
    const type = String(event?.type ?? '');
    const p = event?.payload ?? {};
    const marketId = String(event?.marketId ?? p.marketId ?? '');
    const question = this.questions.get(marketId) ?? marketId;

    if (type === 'market.created') {
      this.note(`New listing ${marketId}`);
      return;
    }

    if (type === 'market.trade.executed') {
      const price = Number(p.priceYes);
      const handle = String(p.handle ?? p.userId ?? '').replace(/^@/, '');
      if (handle) {
        const existing = this.traders.get(handle);
        const credits = Number(p.balance ?? p.availableBalance ?? existing?.credits ?? 0);
        this.traders.set(handle, {
          handle,
          credits,
          seedCredits: Number(p.seed ?? existing?.seedCredits ?? credits),
        });
      }
      this.note(`${handle ? '@' + handle : 'someone'} bought ${p.outcome ?? '?'} on ${marketId}${Number.isFinite(price) ? ` at ${(price * 100).toFixed(1)}%` : ''}`);

      if (Number.isFinite(price)) {
        const prev = this.lastPrice.get(marketId);
        this.lastPrice.set(marketId, price);
        if (prev !== undefined && Math.abs(price - prev) >= 0.08) {
          this.swings.push({ marketId, question, from: prev, to: price });
          if (this.swings.length > 3) this.swings.shift();
        }
      }
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
