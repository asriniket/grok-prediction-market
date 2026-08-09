import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { calculateKarma } from "../domain/karma.js";
import { ConflictError, AppError, NotFoundError } from "../domain/errors.js";
import { outcomePrice, proceedsForSale, sharesForBudget, type AmmState } from "../domain/lmsr.js";
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
  SourcePost,
  Trade,
} from "../domain/types.js";

/**
 * NOTE: no longer on the runtime path. The app runs on PostgresStore against
 * shared Neon; this remains ONLY for the in-memory unit tests, where a local
 * file is the right tool — running unit tests against the shared book would be
 * slow and would let tests mutate live market data.
 */
type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
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
    resolvedOutcome: row.resolved_outcome === null ? null : String(row.resolved_outcome) as Outcome,
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

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        x_user_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        account_created_at TEXT NOT NULL,
        post_count INTEGER NOT NULL,
        median_impressions REAL,
        impression_sample_size INTEGER NOT NULL,
        karma_seed REAL NOT NULL,
        available_balance REAL NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS markets (
        id TEXT PRIMARY KEY,
        source_post_id TEXT NOT NULL UNIQUE,
        source_url TEXT NOT NULL,
        source_text TEXT NOT NULL,
        source_author_id TEXT NOT NULL,
        source_author_handle TEXT NOT NULL,
        source_created_at TEXT NOT NULL,
        creator_user_id TEXT NOT NULL,
        question TEXT NOT NULL,
        summary TEXT,
        analysis TEXT,
        resolution_criteria TEXT NOT NULL,
        closes_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('OPEN', 'RESOLVED', 'UNRESOLVABLE')),
        resolved_outcome TEXT CHECK(resolved_outcome IN ('YES', 'NO')),
        resolution_sources TEXT NOT NULL,
        liquidity_b REAL NOT NULL,
        yes_shares REAL NOT NULL,
        no_shares REAL NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS positions (
        market_id TEXT NOT NULL REFERENCES markets(id),
        user_id TEXT NOT NULL REFERENCES accounts(x_user_id),
        yes_shares REAL NOT NULL DEFAULT 0,
        no_shares REAL NOT NULL DEFAULT 0,
        net_spend REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(market_id, user_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL REFERENCES markets(id),
        user_id TEXT NOT NULL REFERENCES accounts(x_user_id),
        side TEXT NOT NULL DEFAULT 'BUY' CHECK(side IN ('BUY', 'SELL')),
        outcome TEXT NOT NULL CHECK(outcome IN ('YES', 'NO')),
        credits REAL NOT NULL,
        shares REAL NOT NULL,
        price_after REAL NOT NULL,
        executed_at TEXT NOT NULL,
        idempotency_key TEXT,
        request_amount REAL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ledger_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES accounts(x_user_id),
        market_id TEXT REFERENCES markets(id),
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bot_processed_mentions (
        mention_post_id TEXT PRIMARY KEY,
        reply_post_id TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bot_credentials (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        user_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS market_price_points (
        id INTEGER PRIMARY KEY,
        market_id TEXT NOT NULL REFERENCES markets(id),
        price_yes REAL NOT NULL CHECK(price_yes >= 0 AND price_yes <= 1),
        kind TEXT NOT NULL DEFAULT 'TRADE' CHECK(kind IN ('OPEN', 'TRADE', 'DEMO')),
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_market_price_points_market_id_id
      ON market_price_points(market_id, id);
    `);
    // Existing local hackathon databases predate these columns. Keep this a
    // forward-only, data-preserving migration instead of recreating tables.
    this.ensureColumn("trades", "side", "TEXT NOT NULL DEFAULT 'BUY' CHECK(side IN ('BUY', 'SELL'))");
    this.ensureColumn("trades", "idempotency_key", "TEXT");
    this.ensureColumn("trades", "request_amount", "REAL");
    this.ensureColumn("market_price_points", "kind", "TEXT NOT NULL DEFAULT 'TRADE' CHECK(kind IN ('OPEN', 'TRADE', 'DEMO'))");
    this.ensureColumn("markets", "summary", "TEXT");
    this.ensureColumn("markets", "analysis", "TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_idempotency_key ON trades(idempotency_key) WHERE idempotency_key IS NOT NULL");
    this.db.exec("PRAGMA optimize");
  }

  private ensureColumn(table: "markets" | "trades" | "market_price_points", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((item) => String(item.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createAccountIfAbsent(input: AccountHistoryInput): { account: Account; created: boolean } {
    return this.transaction(() => {
      const existing = this.getAccount(input.xUserId);
      if (existing) return { account: existing, created: false };
      const karma = calculateKarma(input);
      const createdAt = now();
      this.db.prepare(`
        INSERT INTO accounts (x_user_id, handle, account_created_at, post_count, median_impressions, impression_sample_size, karma_seed, available_balance, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.xUserId,
        input.handle.replace(/^@/, ""),
        input.accountCreatedAt,
        input.postCount,
        karma.medianImpressions,
        karma.sampleSize,
        karma.seed,
        karma.seed,
        createdAt,
      );
      this.insertLedger(input.xUserId, null, "KARMA_SEED", karma.seed, "Public-history karma seed");
      return { account: this.getAccount(input.xUserId)!, created: true };
    });
  }

  getAccount(xUserId: string): Account | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE x_user_id = ?").get(xUserId) as Row | undefined;
    return row ? accountFromRow(row) : null;
  }

  createMarket(input: {
    sourcePost: SourcePost;
    creatorUserId: string;
    question: string;
    summary?: string | null;
    resolutionCriteria: string[];
    closesAt: string;
    liquidityB: number;
  }): Market {
    return this.transaction(() => {
      const existing = this.getMarketBySourcePost(input.sourcePost.id);
      if (existing) throw new ConflictError("A market already exists for this source post");
      const id = randomUUID();
      const createdAt = now();
      this.db.prepare(`
        INSERT INTO markets (
          id, source_post_id, source_url, source_text, source_author_id, source_author_handle, source_created_at,
          creator_user_id, question, summary, resolution_criteria, closes_at, status, resolved_outcome, resolution_sources,
          liquidity_b, yes_shares, no_shares, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, '[]', ?, 0, 0, ?, NULL)
      `).run(
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
      );
      this.insertPricePoint(id, 0.5, createdAt, "OPEN");
      return this.getMarket(id)!;
    });
  }

  getMarket(marketId: string): Market | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE id = ?").get(marketId) as Row | undefined;
    return row ? marketFromRow(row) : null;
  }

  saveMarketSummary(marketId: string, summary: string): string {
    return this.transaction(() => {
      const market = this.getMarket(marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (market.summary) return market.summary;
      this.db.prepare("UPDATE markets SET summary = ? WHERE id = ?").run(summary, marketId);
      return summary;
    });
  }

  saveMarketAnalysis(marketId: string, analysis: MarketAnalysis, replace = false): MarketAnalysis {
    return this.transaction(() => {
      const market = this.getMarket(marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (market.analysis && !replace) return market.analysis;
      this.db.prepare("UPDATE markets SET analysis = ? WHERE id = ?").run(JSON.stringify(analysis), marketId);
      return analysis;
    });
  }

  getMarketBySourcePost(sourcePostId: string): Market | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE source_post_id = ?").get(sourcePostId) as Row | undefined;
    return row ? marketFromRow(row) : null;
  }

  listMarkets(limit = 50): Market[] {
    const rows = this.db.prepare("SELECT * FROM markets ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(marketFromRow);
  }

  getPosition(marketId: string, userId: string): Position | null {
    const row = this.db.prepare("SELECT * FROM positions WHERE market_id = ? AND user_id = ?").get(marketId, userId) as Row | undefined;
    return row ? positionFromRow(row) : null;
  }

  private tradeForIdempotencyKey(idempotencyKey: string): { trade: Trade; requestAmount: number | null } | null {
    const row = this.db.prepare("SELECT * FROM trades WHERE idempotency_key = ?").get(idempotencyKey) as Row | undefined;
    if (!row) return null;
    return {
      trade: tradeFromRow(row),
      requestAmount: row.request_amount === null || row.request_amount === undefined ? null : numeric(row.request_amount),
    };
  }

  getMarketSnapshot(marketId: string, userId?: string): MarketSnapshot {
    return this.getMarketSnapshotWithHistory(marketId, userId, 120).snapshot;
  }

  getMarketSnapshotWithHistory(
    marketId: string,
    userId?: string,
    historyLimit = 240,
  ): { snapshot: MarketSnapshot; history: MarketPricePoint[] } {
    const market = this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    const history = this.getPriceHistory(marketId, historyLimit);
    const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
    return {
      snapshot: {
        market,
        priceYes: outcomePrice(state, "YES"),
        priceNo: outcomePrice(state, "NO"),
        position: userId ? this.getPosition(marketId, userId) : null,
        metrics: this.metricsForMarket(market, history.slice(-120)),
      },
      history,
    };
  }

  getPriceHistory(marketId: string, limit = 240): MarketPricePoint[] {
    const market = this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    const rows = this.db.prepare(`
      SELECT market_id, price_yes, recorded_at, kind FROM (
        SELECT market_id, price_yes, recorded_at, kind, id
        FROM market_price_points WHERE market_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(marketId, limit) as Row[];
    if (rows.length === 0) {
      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      return [{ marketId, priceYes: outcomePrice(state, "YES"), recordedAt: market.createdAt, kind: "OPEN" }];
    }
    return rows.map((row) => ({
      marketId: String(row.market_id),
      priceYes: numeric(row.price_yes),
      recordedAt: String(row.recorded_at),
      kind: String(row.kind) as MarketPricePoint["kind"],
    }));
  }

  getMarketMetrics(marketId: string): MarketMetrics {
    const market = this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    return this.metricsForMarket(market, this.getPriceHistory(marketId, 120));
  }

  private metricsForMarket(market: Market, points: MarketPricePoint[]): MarketMetrics {
    const moves = points.slice(1).map((point, index) => Math.abs(point.priceYes - points[index].priceYes));
    return {
      liquidityDepth: market.liquidityB,
      volatility: moves.length === 0 ? 0 : moves.reduce((total, movement) => total + movement, 0) / moves.length,
      activityCount: Math.max(0, points.length - 1),
      demoActivityCount: points.filter((point) => point.kind === "DEMO").length,
    };
  }

  buy(input: { marketId: string; userId: string; outcome: Outcome; credits: number; idempotencyKey?: string }): Trade {
    if (!Number.isFinite(input.credits) || input.credits <= 0) {
      throw new AppError("credits must be positive", 422, "INVALID_TRADE");
    }
    return this.transaction(() => {
      const market = this.getMarket(input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (input.idempotencyKey) {
        const previous = this.tradeForIdempotencyKey(input.idempotencyKey);
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
      const account = this.getAccount(input.userId);
      if (!account) throw new NotFoundError("Create a karma account before trading");
      if (input.credits > account.availableBalance + 1e-8) throw new AppError("Insufficient karma balance", 422, "INSUFFICIENT_BALANCE");

      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      const { shares, actualCost } = sharesForBudget(state, input.outcome, input.credits);
      const nextYes = input.outcome === "YES" ? market.yesShares + shares : market.yesShares;
      const nextNo = input.outcome === "NO" ? market.noShares + shares : market.noShares;
      const nextState = { liquidityB: market.liquidityB, yesShares: nextYes, noShares: nextNo };
      const trade: Trade = {
        id: randomUUID(),
        marketId: market.id,
        userId: input.userId,
        side: "BUY",
        outcome: input.outcome,
        credits: actualCost,
        shares,
        priceAfter: outcomePrice(nextState, "YES"),
        executedAt: now(),
        idempotencyKey: input.idempotencyKey,
      };

      this.db.prepare("UPDATE markets SET yes_shares = ?, no_shares = ? WHERE id = ?").run(nextYes, nextNo, market.id);
      this.insertPricePoint(market.id, trade.priceAfter, trade.executedAt, "TRADE");
      this.db.prepare(`
        INSERT INTO positions (market_id, user_id, yes_shares, no_shares, net_spend)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(market_id, user_id) DO UPDATE SET
          yes_shares = yes_shares + excluded.yes_shares,
          no_shares = no_shares + excluded.no_shares,
          net_spend = net_spend + excluded.net_spend
      `).run(market.id, input.userId, input.outcome === "YES" ? shares : 0, input.outcome === "NO" ? shares : 0, actualCost);
      this.db.prepare("UPDATE accounts SET available_balance = available_balance - ? WHERE x_user_id = ?").run(actualCost, input.userId);
      this.db.prepare("INSERT INTO trades (id, market_id, user_id, side, outcome, credits, shares, price_after, executed_at, idempotency_key, request_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(trade.id, trade.marketId, trade.userId, trade.side, trade.outcome, trade.credits, trade.shares, trade.priceAfter, trade.executedAt, input.idempotencyKey ?? null, input.credits);
      this.insertLedger(input.userId, market.id, "TRADE_BUY", -actualCost, `${input.outcome} shares`);
      return trade;
    });
  }

  sell(input: { marketId: string; userId: string; outcome: Outcome; shares: number; idempotencyKey?: string }): Trade {
    if (!Number.isFinite(input.shares) || input.shares <= 0) {
      throw new AppError("shares must be positive", 422, "INVALID_TRADE");
    }
    return this.transaction(() => {
      const market = this.getMarket(input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (input.idempotencyKey) {
        const previous = this.tradeForIdempotencyKey(input.idempotencyKey);
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
      const position = this.getPosition(market.id, input.userId);
      const owned = input.outcome === "YES" ? position?.yesShares ?? 0 : position?.noShares ?? 0;
      if (input.shares > owned + 1e-8) {
        throw new AppError(`You only hold ${owned.toFixed(2)} ${input.outcome} shares`, 422, "INSUFFICIENT_SHARES");
      }
      // A near-equal request may be a rounded browser value. Sell the actual
      // balance so floating point residue cannot leave a negative position.
      const shares = Math.min(input.shares, owned);
      if (shares <= 1e-8) {
        throw new AppError(`You only hold ${owned.toFixed(2)} ${input.outcome} shares`, 422, "INSUFFICIENT_SHARES");
      }

      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      const proceeds = proceedsForSale(state, input.outcome, shares);
      const nextYes = input.outcome === "YES" ? Math.max(0, market.yesShares - shares) : market.yesShares;
      const nextNo = input.outcome === "NO" ? Math.max(0, market.noShares - shares) : market.noShares;
      const nextState = { liquidityB: market.liquidityB, yesShares: nextYes, noShares: nextNo };
      const trade: Trade = {
        id: randomUUID(),
        marketId: market.id,
        userId: input.userId,
        side: "SELL",
        outcome: input.outcome,
        credits: proceeds,
        shares,
        priceAfter: outcomePrice(nextState, "YES"),
        executedAt: now(),
        idempotencyKey: input.idempotencyKey,
      };

      this.db.prepare("UPDATE markets SET yes_shares = ?, no_shares = ? WHERE id = ?").run(nextYes, nextNo, market.id);
      this.insertPricePoint(market.id, trade.priceAfter, trade.executedAt, "TRADE");
      this.db.prepare(`
        UPDATE positions SET
          yes_shares = yes_shares - ?,
          no_shares = no_shares - ?,
          net_spend = net_spend - ?
        WHERE market_id = ? AND user_id = ?
      `).run(input.outcome === "YES" ? shares : 0, input.outcome === "NO" ? shares : 0, proceeds, market.id, input.userId);
      this.db.prepare("UPDATE accounts SET available_balance = available_balance + ? WHERE x_user_id = ?").run(proceeds, input.userId);
      this.db.prepare("INSERT INTO trades (id, market_id, user_id, side, outcome, credits, shares, price_after, executed_at, idempotency_key, request_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(trade.id, trade.marketId, trade.userId, trade.side, trade.outcome, trade.credits, trade.shares, trade.priceAfter, trade.executedAt, input.idempotencyKey ?? null, input.shares);
      this.insertLedger(input.userId, market.id, "TRADE_SELL", proceeds, `${input.outcome} shares`);
      return trade;
    });
  }

  applyDemoFlow(input: { marketId: string; outcome: Outcome; shares: number }): { outcome: Outcome; shares: number; priceAfter: number; executedAt: string } | null {
    return this.transaction(() => {
      const market = this.getMarket(input.marketId);
      if (!market || market.status !== "OPEN" || new Date(market.closesAt) <= new Date()) return null;
      if (!Number.isFinite(input.shares) || input.shares <= 0) return null;
      const nextYes = input.outcome === "YES" ? market.yesShares + input.shares : market.yesShares;
      const nextNo = input.outcome === "NO" ? market.noShares + input.shares : market.noShares;
      const priceAfter = outcomePrice({ liquidityB: market.liquidityB, yesShares: nextYes, noShares: nextNo }, "YES");
      const executedAt = now();
      this.db.prepare("UPDATE markets SET yes_shares = ?, no_shares = ? WHERE id = ?").run(nextYes, nextNo, market.id);
      this.insertPricePoint(market.id, priceAfter, executedAt, "DEMO");
      return { outcome: input.outcome, shares: input.shares, priceAfter, executedAt };
    });
  }

  resolve(input: { marketId: string; outcome: Outcome | null; sources: string[] }): Market {
    return this.transaction(() => {
      const market = this.getMarket(input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (market.status !== "OPEN") throw new ConflictError("Market has already been resolved");
      if (input.sources.length === 0) {
        throw new AppError("A settlement needs at least one source URL", 422, "EVIDENCE_REQUIRED");
      }
      const status: MarketStatus = input.outcome === null ? "UNRESOLVABLE" : "RESOLVED";
      const resolvedAt = now();
      const positions = this.db.prepare("SELECT * FROM positions WHERE market_id = ? ORDER BY user_id").all(market.id) as Row[];
      for (const rawPosition of positions) {
        const position = positionFromRow(rawPosition);
        const payout = input.outcome === null
          ? Math.max(0, position.netSpend)
          : input.outcome === "YES" ? position.yesShares : position.noShares;
        if (payout > 0) {
          this.db.prepare("UPDATE accounts SET available_balance = available_balance + ? WHERE x_user_id = ?").run(payout, position.userId);
          this.insertLedger(
            position.userId,
            market.id,
            input.outcome === null ? "UNRESOLVABLE_REFUND" : "RESOLUTION_PAYOUT",
            payout,
            input.outcome === null ? "Remaining net trade-spend refund" : `${input.outcome} settlement payout`,
          );
        }
      }
      // Payouts are recorded in the immutable ledger. A settled market must
      // not retain tradeable or portfolio-visible shares.
      this.db.prepare("UPDATE positions SET yes_shares = 0, no_shares = 0, net_spend = 0 WHERE market_id = ?").run(market.id);
      this.db.prepare("UPDATE markets SET status = ?, resolved_outcome = ?, resolution_sources = ?, resolved_at = ? WHERE id = ?")
        .run(status, input.outcome, JSON.stringify(input.sources), resolvedAt, market.id);
      return this.getMarket(market.id)!;
    });
  }

  isMentionProcessed(mentionPostId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM bot_processed_mentions WHERE mention_post_id = ?")
      .get(mentionPostId) as Row | undefined;
    return Boolean(row);
  }

  markMentionProcessed(mentionPostId: string, replyPostId?: string): void {
    this.db.prepare("INSERT OR IGNORE INTO bot_processed_mentions (mention_post_id, reply_post_id, created_at) VALUES (?, ?, ?)")
      .run(mentionPostId, replyPostId ?? null, now());
  }

  getBotCredentials(): BotCredentials | null {
    const row = this.db.prepare("SELECT user_id, access_token, refresh_token FROM bot_credentials WHERE id = 1").get() as Row | undefined;
    if (!row) return null;
    return {
      userId: String(row.user_id),
      accessToken: String(row.access_token),
      refreshToken: row.refresh_token === null ? undefined : String(row.refresh_token),
    };
  }

  saveBotCredentials(credentials: BotCredentials): void {
    this.db.prepare(`
      INSERT INTO bot_credentials (id, user_id, access_token, refresh_token, updated_at)
      VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_id = excluded.user_id,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        updated_at = excluded.updated_at
    `).run(credentials.userId, credentials.accessToken, credentials.refreshToken ?? null, now());
  }

  private insertLedger(userId: string, marketId: string | null, kind: string, amount: number, note: string): void {
    this.db.prepare("INSERT INTO ledger_entries (id, user_id, market_id, kind, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, marketId, kind, amount, note, now());
  }

  private insertPricePoint(marketId: string, priceYes: number, recordedAt: string, kind: MarketPricePoint["kind"]): void {
    this.db.prepare("INSERT INTO market_price_points (market_id, price_yes, kind, recorded_at) VALUES (?, ?, ?, ?)")
      .run(marketId, priceYes, kind, recordedAt);
  }
}
