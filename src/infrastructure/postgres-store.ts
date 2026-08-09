import { randomUUID } from "node:crypto";
import pg from "pg";
import { calculateKarma } from "../domain/karma.js";
import { ConflictError, AppError, NotFoundError } from "../domain/errors.js";
import { lmsrCost, outcomePrice, proceedsForSale, sharesForBudget, type AmmState } from "../domain/lmsr.js";
import type {
  Account,
  AccountHistoryInput,
  BotCredentials,
  Market,
  MarketAnalysis,
  MarketMetrics,
  MarketPricePoint,
  MarketSnapshot,
  MarketStatus,
  Outcome,
  Position,
  Portfolio,
  PortfolioPosition,
  SourcePost,
  Trade,
} from "../domain/types.js";

/**
 * Postgres-backed store, for a shared book across machines.
 *
 * Mirrors SqliteStore method for method, with the same validation, the same
 * errors, and the same ordering — the only difference is that everything is
 * async, because no synchronous Postgres driver exists.
 *
 * Money movement runs inside a single transaction on ONE pooled client. Reads
 * inside a transaction must use that client too, or they see pre-transaction
 * state and the balance checks become meaningless under concurrency — which is
 * exactly the case a shared database introduces and a local file never had.
 */

type Row = Record<string, unknown>;
type Q = { query: (text: string, values?: unknown[]) => Promise<{ rows: Row[] }> };

function now(): string {
  return new Date().toISOString();
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function parseJson<T>(value: unknown): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

function accountFromRow(row: Row): Account {
  return {
    xUserId: String(row.x_user_id),
    handle: String(row.handle),
    accountCreatedAt: String(row.account_created_at),
    postCount: numeric(row.post_count),
    medianImpressions: row.median_impressions === null ? null : numeric(row.median_impressions),
    impressionSampleSize: numeric(row.impression_sample_size),
    karmaSeed: numeric(row.karma_seed),
    availableBalance: numeric(row.available_balance),
    createdAt: String(row.created_at),
  };
}

function marketFromRow(row: Row): Market {
  return {
    id: String(row.id),
    sourcePost: {
      id: String(row.source_post_id),
      url: String(row.source_url),
      text: String(row.source_text),
      authorId: String(row.source_author_id),
      authorHandle: String(row.source_author_handle),
      createdAt: String(row.source_created_at),
    },
    creatorUserId: String(row.creator_user_id),
    question: String(row.question),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    analysis: analysisFromRow(row.analysis),
    resolutionCriteria: parseJson<string[]>(row.resolution_criteria),
    closesAt: String(row.closes_at),
    status: String(row.status) as MarketStatus,
    resolvedOutcome: row.resolved_outcome === null ? null : (String(row.resolved_outcome) as Outcome),
    resolutionSources: parseJson<string[]>(row.resolution_sources),
    liquidityB: numeric(row.liquidity_b),
    yesShares: numeric(row.yes_shares),
    noShares: numeric(row.no_shares),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

function analysisFromRow(value: unknown): MarketAnalysis | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = parseJson<Partial<MarketAnalysis>>(value);
    if (typeof parsed.body !== "string" || typeof parsed.generatedAt !== "string" || !Array.isArray(parsed.sources)) return null;
    return {
      body: parsed.body,
      sources: parsed.sources.filter((source): source is string => typeof source === "string"),
      posts: Array.isArray(parsed.posts)
        ? parsed.posts.filter((post): post is MarketAnalysis["posts"][number] => Boolean(post) && typeof post === "object"
          && typeof (post as unknown as Record<string, unknown>).url === "string"
          && typeof (post as unknown as Record<string, unknown>).handle === "string"
          && typeof (post as unknown as Record<string, unknown>).text === "string"
          && typeof (post as unknown as Record<string, unknown>).createdAt === "string"
          && typeof (post as unknown as Record<string, unknown>).relevance === "string")
        : [],
      generatedAt: parsed.generatedAt,
    };
  } catch {
    return null;
  }
}

function positionFromRow(row: Row): Position {
  return {
    marketId: String(row.market_id),
    userId: String(row.user_id),
    yesShares: numeric(row.yes_shares),
    noShares: numeric(row.no_shares),
    netSpend: numeric(row.net_spend),
  };
}

function tradeFromRow(row: Row): Trade {
  return {
    id: String(row.id),
    marketId: String(row.market_id),
    userId: String(row.user_id),
    side: String(row.side) as Trade["side"],
    outcome: String(row.outcome) as Outcome,
    credits: numeric(row.credits),
    shares: numeric(row.shares),
    priceAfter: numeric(row.price_after),
    executedAt: String(row.executed_at),
    idempotencyKey: row.idempotency_key === null || row.idempotency_key === undefined ? undefined : String(row.idempotency_key),
  };
}

export class PostgresStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        x_user_id text PRIMARY KEY,
        handle text NOT NULL,
        account_created_at text NOT NULL,
        post_count bigint NOT NULL,
        median_impressions double precision,
        impression_sample_size bigint NOT NULL,
        karma_seed double precision NOT NULL,
        available_balance double precision NOT NULL,
        created_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS markets (
        id text PRIMARY KEY,
        source_post_id text NOT NULL UNIQUE,
        source_url text NOT NULL,
        source_text text NOT NULL,
        source_author_id text NOT NULL,
        source_author_handle text NOT NULL,
        source_created_at text NOT NULL,
        creator_user_id text NOT NULL,
        question text NOT NULL,
        summary text,
        analysis text,
        resolution_criteria text NOT NULL,
        closes_at text NOT NULL,
        status text NOT NULL CHECK(status IN ('OPEN','RESOLVED','UNRESOLVABLE')),
        resolved_outcome text CHECK(resolved_outcome IN ('YES','NO')),
        resolution_sources text NOT NULL,
        liquidity_b double precision NOT NULL,
        yes_shares double precision NOT NULL,
        no_shares double precision NOT NULL,
        created_at text NOT NULL,
        resolved_at text
      );
      CREATE TABLE IF NOT EXISTS positions (
        market_id text NOT NULL REFERENCES markets(id),
        user_id text NOT NULL REFERENCES accounts(x_user_id),
        yes_shares double precision NOT NULL DEFAULT 0,
        no_shares double precision NOT NULL DEFAULT 0,
        net_spend double precision NOT NULL DEFAULT 0,
        PRIMARY KEY(market_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS trades (
        id text PRIMARY KEY,
        market_id text NOT NULL REFERENCES markets(id),
        user_id text NOT NULL REFERENCES accounts(x_user_id),
        side text NOT NULL DEFAULT 'BUY' CHECK(side IN ('BUY','SELL')),
        outcome text NOT NULL CHECK(outcome IN ('YES','NO')),
        credits double precision NOT NULL,
        shares double precision NOT NULL,
        price_after double precision NOT NULL,
        executed_at text NOT NULL,
        idempotency_key text,
        request_amount double precision
      );
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES accounts(x_user_id),
        market_id text REFERENCES markets(id),
        kind text NOT NULL,
        amount double precision NOT NULL,
        note text NOT NULL,
        created_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_processed_mentions (
        mention_post_id text PRIMARY KEY,
        reply_post_id text,
        created_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_credentials (
        id integer PRIMARY KEY CHECK(id = 1),
        user_id text NOT NULL,
        access_token text NOT NULL,
        refresh_token text,
        updated_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS market_price_points (
        id bigserial PRIMARY KEY,
        market_id text NOT NULL REFERENCES markets(id),
        price_yes double precision NOT NULL CHECK(price_yes >= 0 AND price_yes <= 1),
        kind text NOT NULL DEFAULT 'TRADE' CHECK(kind IN ('OPEN','TRADE','DEMO')),
        recorded_at text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_market_price_points_market_id_id
        ON market_price_points(market_id, id);
    `);
    // Existing shared books predate the market brief. Add it without rewriting
    // any markets that have already been created.
    await this.pool.query("ALTER TABLE markets ADD COLUMN IF NOT EXISTS summary text");
    await this.pool.query("ALTER TABLE markets ADD COLUMN IF NOT EXISTS analysis text");
    await this.pool.query("ALTER TABLE trades ADD COLUMN IF NOT EXISTS idempotency_key text");
    await this.pool.query("ALTER TABLE trades ADD COLUMN IF NOT EXISTS request_amount double precision");
    await this.pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_idempotency_key ON trades(idempotency_key) WHERE idempotency_key IS NOT NULL");
  }

  /** Runs `work` on one client inside a transaction. */
  private async transaction<T>(work: (client: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client as unknown as Q);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertLedger(q: Q, userId: string, marketId: string | null, kind: string, amount: number, note: string) {
    await q.query(
      "INSERT INTO ledger_entries (id, user_id, market_id, kind, amount, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), userId, marketId, kind, amount, note, now()],
    );
  }

  private async insertPricePoint(q: Q, marketId: string, priceYes: number, recordedAt: string, kind: string) {
    await q.query("INSERT INTO market_price_points (market_id, price_yes, kind, recorded_at) VALUES ($1,$2,$3,$4)", [
      marketId,
      priceYes,
      kind,
      recordedAt,
    ]);
  }

  private async marketOn(q: Q, marketId: string): Promise<Market | null> {
    const { rows } = await q.query("SELECT * FROM markets WHERE id = $1", [marketId]);
    return rows[0] ? marketFromRow(rows[0]) : null;
  }

  private async marketForUpdate(q: Q, marketId: string): Promise<Market | null> {
    const { rows } = await q.query("SELECT * FROM markets WHERE id = $1 FOR UPDATE", [marketId]);
    return rows[0] ? marketFromRow(rows[0]) : null;
  }

  private async accountOn(q: Q, xUserId: string): Promise<Account | null> {
    const { rows } = await q.query("SELECT * FROM accounts WHERE x_user_id = $1", [xUserId]);
    return rows[0] ? accountFromRow(rows[0]) : null;
  }

  private async accountForUpdate(q: Q, xUserId: string): Promise<Account | null> {
    const { rows } = await q.query("SELECT * FROM accounts WHERE x_user_id = $1 FOR UPDATE", [xUserId]);
    return rows[0] ? accountFromRow(rows[0]) : null;
  }

  private async positionOn(q: Q, marketId: string, userId: string): Promise<Position | null> {
    const { rows } = await q.query("SELECT * FROM positions WHERE market_id = $1 AND user_id = $2", [marketId, userId]);
    return rows[0] ? positionFromRow(rows[0]) : null;
  }

  private async positionForUpdate(q: Q, marketId: string, userId: string): Promise<Position | null> {
    const { rows } = await q.query("SELECT * FROM positions WHERE market_id = $1 AND user_id = $2 FOR UPDATE", [marketId, userId]);
    return rows[0] ? positionFromRow(rows[0]) : null;
  }

  private async tradeForIdempotencyKey(q: Q, idempotencyKey: string): Promise<{ trade: Trade; requestAmount: number | null } | null> {
    const { rows } = await q.query("SELECT * FROM trades WHERE idempotency_key = $1", [idempotencyKey]);
    if (!rows[0]) return null;
    return {
      trade: tradeFromRow(rows[0]),
      requestAmount: rows[0].request_amount === null || rows[0].request_amount === undefined ? null : numeric(rows[0].request_amount),
    };
  }

  // ------------------------------------------------------------- accounts

  async createAccountIfAbsent(input: AccountHistoryInput): Promise<{ account: Account; created: boolean }> {
    return this.transaction(async (q) => {
      const existing = await this.accountOn(q, input.xUserId);
      if (existing) return { account: existing, created: false };
      const karma = calculateKarma(input);
      await q.query(
        `INSERT INTO accounts (x_user_id, handle, account_created_at, post_count, median_impressions,
           impression_sample_size, karma_seed, available_balance, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.xUserId,
          input.handle.replace(/^@/, ""),
          input.accountCreatedAt,
          input.postCount,
          karma.medianImpressions,
          karma.sampleSize,
          karma.seed,
          karma.seed,
          now(),
        ],
      );
      await this.insertLedger(q, input.xUserId, null, "KARMA_SEED", karma.seed, "Public-history karma seed");
      return { account: (await this.accountOn(q, input.xUserId))!, created: true };
    });
  }

  async getAccount(xUserId: string): Promise<Account | null> {
    return this.accountOn(this.pool as unknown as Q, xUserId);
  }

  // -------------------------------------------------------------- markets

  async createMarket(input: {
    sourcePost: SourcePost;
    creatorUserId: string;
    question: string;
    summary?: string | null;
    resolutionCriteria: string[];
    closesAt: string;
    liquidityB: number;
  }): Promise<Market> {
    return this.transaction(async (q) => {
      const dupe = await q.query("SELECT * FROM markets WHERE source_post_id = $1", [input.sourcePost.id]);
      if (dupe.rows[0]) throw new ConflictError("A market already exists for this source post");
      const id = randomUUID();
      const createdAt = now();
      await q.query(
        `INSERT INTO markets (
           id, source_post_id, source_url, source_text, source_author_id, source_author_handle, source_created_at,
           creator_user_id, question, summary, resolution_criteria, closes_at, status, resolved_outcome, resolution_sources,
           liquidity_b, yes_shares, no_shares, created_at, resolved_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'OPEN',NULL,'[]',$13,0,0,$14,NULL)`,
        [
          id,
          input.sourcePost.id,
          input.sourcePost.url,
          input.sourcePost.text,
          input.sourcePost.authorId,
          input.sourcePost.authorHandle.replace(/^@/, ""),
          input.sourcePost.createdAt,
          input.creatorUserId,
          input.question,
          input.summary ?? null,
          JSON.stringify(input.resolutionCriteria),
          input.closesAt,
          input.liquidityB,
          createdAt,
        ],
      );
      await this.insertPricePoint(q, id, 0.5, createdAt, "OPEN");
      return (await this.marketOn(q, id))!;
    });
  }

  async getMarket(marketId: string): Promise<Market | null> {
    return this.marketOn(this.pool as unknown as Q, marketId);
  }

  /** Persists the first successful brief; concurrent viewers receive the same one. */
  async saveMarketSummary(marketId: string, summary: string): Promise<string> {
    const { rows } = await this.pool.query(
      "UPDATE markets SET summary = COALESCE(summary, $1) WHERE id = $2 RETURNING summary",
      [summary, marketId],
    );
    if (!rows[0]) throw new NotFoundError("Market not found");
    return String(rows[0].summary);
  }

  /** Persists the first successful X pulse so opening a market only searches once. */
  async saveMarketAnalysis(marketId: string, analysis: MarketAnalysis, replace = false): Promise<MarketAnalysis> {
    const { rows } = await this.pool.query(
      "UPDATE markets SET analysis = CASE WHEN $3 THEN $1 ELSE COALESCE(analysis, $1) END WHERE id = $2 RETURNING analysis",
      [JSON.stringify(analysis), marketId, replace],
    );
    if (!rows[0]) throw new NotFoundError("Market not found");
    const saved = analysisFromRow(rows[0].analysis);
    if (!saved) throw new AppError("Saved market analysis is invalid", 500, "ANALYSIS_STORAGE_ERROR");
    return saved;
  }

  async getMarketBySourcePost(sourcePostId: string): Promise<Market | null> {
    const { rows } = await this.pool.query("SELECT * FROM markets WHERE source_post_id = $1", [sourcePostId]);
    return rows[0] ? marketFromRow(rows[0]) : null;
  }

  async listMarkets(limit = 50): Promise<Market[]> {
    const { rows } = await this.pool.query("SELECT * FROM markets ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows.map(marketFromRow);
  }

  async getPosition(marketId: string, userId: string): Promise<Position | null> {
    return this.positionOn(this.pool as unknown as Q, marketId, userId);
  }

  async getPortfolio(userId: string): Promise<Portfolio | null> {
    const account = await this.getAccount(userId);
    if (!account) return null;
    const { rows } = await this.pool.query(
      `SELECT market_id
       FROM positions
       WHERE user_id = $1 AND (yes_shares > 0.00000001 OR no_shares > 0.00000001)`,
      [userId],
    );
    const positions = (await Promise.all(rows.map(async (row) => {
      const snapshot = await this.getMarketSnapshot(String(row.market_id), userId);
      const position = snapshot.position!;
      // Settled shares are already reflected in the wallet and aren't open risk.
      if (snapshot.market.status !== "OPEN") return null;
      const state: AmmState = {
        liquidityB: snapshot.market.liquidityB,
        yesShares: snapshot.market.yesShares,
        noShares: snapshot.market.noShares,
      };
      const exitState: AmmState = {
        ...state,
        yesShares: Math.max(0, state.yesShares - position.yesShares),
        noShares: Math.max(0, state.noShares - position.noShares),
      };
      const estimatedExitValue = lmsrCost(state) - lmsrCost(exitState);
      const item: PortfolioPosition = {
        market: snapshot.market,
        position,
        priceYes: snapshot.priceYes,
        priceNo: snapshot.priceNo,
        estimatedExitValue,
        openPnl: estimatedExitValue - position.netSpend,
      };
      return item;
    }))).filter((item): item is PortfolioPosition => item !== null);
    const estimatedExitValue = positions.reduce((total, item) => total + item.estimatedExitValue, 0);
    return { account, positions, estimatedExitValue, totalEquity: account.availableBalance + estimatedExitValue };
  }

  async getMarketSnapshot(marketId: string, userId?: string): Promise<MarketSnapshot> {
    const market = await this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    const [points, position] = await Promise.all([
      this.priceHistoryForMarket(market, 120),
      userId ? this.getPosition(marketId, userId) : Promise.resolve(null),
    ]);
    const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
    return {
      market,
      priceYes: outcomePrice(state, "YES"),
      priceNo: outcomePrice(state, "NO"),
      position,
      metrics: this.metricsForMarket(market, points),
    };
  }

  async getPriceHistory(marketId: string, limit = 240): Promise<MarketPricePoint[]> {
    const market = await this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    return this.priceHistoryForMarket(market, limit);
  }

  private async priceHistoryForMarket(market: Market, limit: number): Promise<MarketPricePoint[]> {
    const { rows } = await this.pool.query(
      `SELECT market_id, price_yes, recorded_at, kind FROM (
         SELECT market_id, price_yes, recorded_at, kind, id
         FROM market_price_points WHERE market_id = $1 ORDER BY id DESC LIMIT $2
       ) recent ORDER BY id ASC`,
      [market.id, limit],
    );
    if (rows.length === 0) {
      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      return [{ marketId: market.id, priceYes: outcomePrice(state, "YES"), recordedAt: market.createdAt, kind: "OPEN" }];
    }
    return rows.map((row) => ({
      marketId: String(row.market_id),
      priceYes: numeric(row.price_yes),
      recordedAt: String(row.recorded_at),
      kind: String(row.kind) as MarketPricePoint["kind"],
    }));
  }

  private metricsForMarket(market: Market, points: MarketPricePoint[]): MarketMetrics {
    const moves = points.slice(1).map((point, index) => Math.abs(point.priceYes - points[index]!.priceYes));
    return {
      liquidityDepth: market.liquidityB,
      volatility: moves.length === 0 ? 0 : moves.reduce((total, movement) => total + movement, 0) / moves.length,
      activityCount: Math.max(0, points.length - 1),
      demoActivityCount: points.filter((point) => point.kind === "DEMO").length,
    };
  }

  async getMarketMetrics(marketId: string): Promise<MarketMetrics> {
    const market = await this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    return this.metricsForMarket(market, await this.priceHistoryForMarket(market, 120));
  }

  // --------------------------------------------------------------- trading

  async buy(input: { marketId: string; userId: string; outcome: Outcome; credits: number; idempotencyKey?: string }): Promise<Trade> {
    if (!Number.isFinite(input.credits) || input.credits <= 0) {
      throw new AppError("credits must be positive", 422, "INVALID_TRADE");
    }
    return this.transaction(async (q) => {
      const market = await this.marketForUpdate(q, input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (input.idempotencyKey) {
        const previous = await this.tradeForIdempotencyKey(q, input.idempotencyKey);
        if (previous) {
          const sameRequest = previous.trade.marketId === input.marketId
            && previous.trade.userId === input.userId
            && previous.trade.side === "BUY"
            && previous.trade.outcome === input.outcome
            && previous.requestAmount !== null
            && Math.abs(previous.requestAmount - input.credits) < 1e-8;
          if (!sameRequest) throw new ConflictError("This idempotency key was already used for a different trade");
          return previous.trade;
        }
      }
      if (market.status !== "OPEN") throw new ConflictError("Trading is closed for this market");
      if (new Date(market.closesAt) <= new Date()) throw new ConflictError("Trading is closed because the market deadline passed");
      const account = await this.accountForUpdate(q, input.userId);
      if (!account) throw new NotFoundError("Create a karma account before trading");
      if (input.credits > account.availableBalance + 1e-8) throw new AppError("Insufficient karma balance", 422, "INSUFFICIENT_BALANCE");

      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      const { shares, actualCost } = sharesForBudget(state, input.outcome, input.credits);
      const nextYes = input.outcome === "YES" ? market.yesShares + shares : market.yesShares;
      const nextNo = input.outcome === "NO" ? market.noShares + shares : market.noShares;
      const trade: Trade = {
        id: randomUUID(),
        marketId: market.id,
        userId: input.userId,
        side: "BUY",
        outcome: input.outcome,
        credits: actualCost,
        shares,
        priceAfter: outcomePrice({ liquidityB: market.liquidityB, yesShares: nextYes, noShares: nextNo }, "YES"),
        executedAt: now(),
      };

      // Claim the idempotency key before any balance or AMM mutation. This
      // also handles two concurrent requests that accidentally reuse a key
      // across different markets, where a market row lock alone is not enough.
      const inserted = await q.query(
        `INSERT INTO trades (id, market_id, user_id, side, outcome, credits, shares, price_after, executed_at, idempotency_key, request_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [trade.id, trade.marketId, trade.userId, trade.side, trade.outcome, trade.credits, trade.shares, trade.priceAfter, trade.executedAt, input.idempotencyKey ?? null, input.credits],
      );
      if (input.idempotencyKey && inserted.rows.length === 0) {
        const previous = await this.tradeForIdempotencyKey(q, input.idempotencyKey);
        const sameRequest = previous
          && previous.trade.marketId === input.marketId
          && previous.trade.userId === input.userId
          && previous.trade.side === "BUY"
          && previous.trade.outcome === input.outcome
          && previous.requestAmount !== null
          && Math.abs(previous.requestAmount - input.credits) < 1e-8;
        if (sameRequest) return previous.trade;
        throw new ConflictError("This idempotency key was already used for a different trade");
      }
      await q.query("UPDATE markets SET yes_shares = $1, no_shares = $2 WHERE id = $3", [nextYes, nextNo, market.id]);
      await this.insertPricePoint(q, market.id, trade.priceAfter, trade.executedAt, "TRADE");
      await q.query(
        `INSERT INTO positions (market_id, user_id, yes_shares, no_shares, net_spend)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT(market_id, user_id) DO UPDATE SET
           yes_shares = positions.yes_shares + EXCLUDED.yes_shares,
           no_shares = positions.no_shares + EXCLUDED.no_shares,
           net_spend = positions.net_spend + EXCLUDED.net_spend`,
        [market.id, input.userId, input.outcome === "YES" ? shares : 0, input.outcome === "NO" ? shares : 0, actualCost],
      );
      await q.query("UPDATE accounts SET available_balance = available_balance - $1 WHERE x_user_id = $2", [actualCost, input.userId]);
      await this.insertLedger(q, input.userId, market.id, "TRADE_BUY", -actualCost, `${input.outcome} shares`);
      return { ...trade, idempotencyKey: input.idempotencyKey };
    });
  }

  async sell(input: { marketId: string; userId: string; outcome: Outcome; shares: number; idempotencyKey?: string }): Promise<Trade> {
    if (!Number.isFinite(input.shares) || input.shares <= 0) {
      throw new AppError("shares must be positive", 422, "INVALID_TRADE");
    }
    return this.transaction(async (q) => {
      const market = await this.marketForUpdate(q, input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (input.idempotencyKey) {
        const previous = await this.tradeForIdempotencyKey(q, input.idempotencyKey);
        if (previous) {
          const sameRequest = previous.trade.marketId === input.marketId
            && previous.trade.userId === input.userId
            && previous.trade.side === "SELL"
            && previous.trade.outcome === input.outcome
            && previous.requestAmount !== null
            && Math.abs(previous.requestAmount - input.shares) < 1e-8;
          if (!sameRequest) throw new ConflictError("This idempotency key was already used for a different trade");
          return previous.trade;
        }
      }
      if (market.status !== "OPEN" || new Date(market.closesAt) <= new Date()) {
        throw new ConflictError("Trading is closed for this market");
      }
      const position = await this.positionForUpdate(q, market.id, input.userId);
      const owned = input.outcome === "YES" ? position?.yesShares ?? 0 : position?.noShares ?? 0;
      if (input.shares > owned + 1e-8) {
        throw new AppError(`You only hold ${owned.toFixed(2)} ${input.outcome} shares`, 422, "INSUFFICIENT_SHARES");
      }
      const shares = Math.min(input.shares, owned);
      if (shares <= 1e-8) throw new AppError(`You only hold ${owned.toFixed(2)} ${input.outcome} shares`, 422, "INSUFFICIENT_SHARES");

      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      const proceeds = proceedsForSale(state, input.outcome, shares);
      const nextYes = input.outcome === "YES" ? Math.max(0, market.yesShares - shares) : market.yesShares;
      const nextNo = input.outcome === "NO" ? Math.max(0, market.noShares - shares) : market.noShares;
      const trade: Trade = {
        id: randomUUID(),
        marketId: market.id,
        userId: input.userId,
        side: "SELL",
        outcome: input.outcome,
        credits: proceeds,
        shares,
        priceAfter: outcomePrice({ liquidityB: market.liquidityB, yesShares: nextYes, noShares: nextNo }, "YES"),
        executedAt: now(),
      };

      const inserted = await q.query(
        `INSERT INTO trades (id, market_id, user_id, side, outcome, credits, shares, price_after, executed_at, idempotency_key, request_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [trade.id, trade.marketId, trade.userId, trade.side, trade.outcome, trade.credits, trade.shares, trade.priceAfter, trade.executedAt, input.idempotencyKey ?? null, input.shares],
      );
      if (input.idempotencyKey && inserted.rows.length === 0) {
        const previous = await this.tradeForIdempotencyKey(q, input.idempotencyKey);
        const sameRequest = previous
          && previous.trade.marketId === input.marketId
          && previous.trade.userId === input.userId
          && previous.trade.side === "SELL"
          && previous.trade.outcome === input.outcome
          && previous.requestAmount !== null
          && Math.abs(previous.requestAmount - input.shares) < 1e-8;
        if (sameRequest) return previous.trade;
        throw new ConflictError("This idempotency key was already used for a different trade");
      }
      await q.query("UPDATE markets SET yes_shares = $1, no_shares = $2 WHERE id = $3", [nextYes, nextNo, market.id]);
      await this.insertPricePoint(q, market.id, trade.priceAfter, trade.executedAt, "TRADE");
      await q.query(
        `UPDATE positions SET yes_shares = yes_shares - $1, no_shares = no_shares - $2, net_spend = net_spend - $3
         WHERE market_id = $4 AND user_id = $5`,
        [input.outcome === "YES" ? shares : 0, input.outcome === "NO" ? shares : 0, proceeds, market.id, input.userId],
      );
      await q.query("UPDATE accounts SET available_balance = available_balance + $1 WHERE x_user_id = $2", [proceeds, input.userId]);
      await this.insertLedger(q, input.userId, market.id, "TRADE_SELL", proceeds, `${input.outcome} shares`);
      return { ...trade, idempotencyKey: input.idempotencyKey };
    });
  }

  async applyDemoFlow(input: { marketId: string; outcome: Outcome; shares: number }) {
    return this.transaction(async (q) => {
      const market = await this.marketForUpdate(q, input.marketId);
      if (!market || market.status !== "OPEN" || new Date(market.closesAt) <= new Date()) return null;
      if (!Number.isFinite(input.shares) || input.shares <= 0) return null;
      const nextYes = input.outcome === "YES" ? market.yesShares + input.shares : market.yesShares;
      const nextNo = input.outcome === "NO" ? market.noShares + input.shares : market.noShares;
      const priceAfter = outcomePrice({ liquidityB: market.liquidityB, yesShares: nextYes, noShares: nextNo }, "YES");
      const executedAt = now();
      await q.query("UPDATE markets SET yes_shares = $1, no_shares = $2 WHERE id = $3", [nextYes, nextNo, market.id]);
      await this.insertPricePoint(q, market.id, priceAfter, executedAt, "DEMO");
      return { outcome: input.outcome, shares: input.shares, priceAfter, executedAt };
    });
  }

  async resolve(input: { marketId: string; outcome: Outcome | null; sources: string[] }): Promise<Market> {
    return this.transaction(async (q) => {
      const market = await this.marketForUpdate(q, input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (market.status !== "OPEN") throw new ConflictError("Market has already been resolved");
      if (input.sources.length === 0) {
        throw new AppError("A settlement needs at least one source URL", 422, "EVIDENCE_REQUIRED");
      }
      const status: MarketStatus = input.outcome === null ? "UNRESOLVABLE" : "RESOLVED";
      const resolvedAt = now();
      const { rows } = await q.query("SELECT * FROM positions WHERE market_id = $1 ORDER BY user_id FOR UPDATE", [market.id]);
      for (const raw of rows) {
        const position = positionFromRow(raw);
        const payout =
          input.outcome === null
            ? Math.max(0, position.netSpend)
            : input.outcome === "YES"
              ? position.yesShares
              : position.noShares;
        if (payout > 0) {
          const account = await this.accountForUpdate(q, position.userId);
          if (!account) throw new NotFoundError("Settlement account not found");
          await q.query("UPDATE accounts SET available_balance = available_balance + $1 WHERE x_user_id = $2", [payout, position.userId]);
          await this.insertLedger(
            q,
            position.userId,
            market.id,
            input.outcome === null ? "UNRESOLVABLE_REFUND" : "RESOLUTION_PAYOUT",
            payout,
            input.outcome === null ? "Remaining net trade-spend refund" : `${input.outcome} settlement payout`,
          );
        }
      }
      // Payouts are now represented by immutable ledger entries. Clearing open
      // shares prevents a settled market from remaining a phantom position.
      await q.query("UPDATE positions SET yes_shares = 0, no_shares = 0, net_spend = 0 WHERE market_id = $1", [market.id]);
      await q.query("UPDATE markets SET status = $1, resolved_outcome = $2, resolution_sources = $3, resolved_at = $4 WHERE id = $5", [
        status,
        input.outcome,
        JSON.stringify(input.sources),
        resolvedAt,
        market.id,
      ]);
      return (await this.marketOn(q, market.id))!;
    });
  }

  // ------------------------------------------------------------------ bot

  async isMentionProcessed(mentionPostId: string): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT 1 FROM bot_processed_mentions WHERE mention_post_id = $1", [mentionPostId]);
    return rows.length > 0;
  }

  async markMentionProcessed(mentionPostId: string, replyPostId?: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO bot_processed_mentions (mention_post_id, reply_post_id, created_at) VALUES ($1,$2,$3) ON CONFLICT (mention_post_id) DO NOTHING",
      [mentionPostId, replyPostId ?? null, now()],
    );
  }

  async getBotCredentials(): Promise<BotCredentials | null> {
    const { rows } = await this.pool.query("SELECT user_id, access_token, refresh_token FROM bot_credentials WHERE id = 1");
    const row = rows[0];
    if (!row) return null;
    return {
      userId: String(row.user_id),
      accessToken: String(row.access_token),
      refreshToken: row.refresh_token === null ? undefined : String(row.refresh_token),
    };
  }

  async saveBotCredentials(credentials: BotCredentials): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_credentials (id, user_id, access_token, refresh_token, updated_at)
       VALUES (1,$1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         updated_at = EXCLUDED.updated_at`,
      [credentials.userId, credentials.accessToken, credentials.refreshToken ?? null, now()],
    );
  }
}
