import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { calculateKarma } from "../domain/karma.js";
import { ConflictError, AppError, NotFoundError } from "../domain/errors.js";
import { outcomePrice, sharesForBudget, type AmmState } from "../domain/lmsr.js";
import type {
  Account,
  AccountHistoryInput,
  BotCredentials,
  Market,
  MarketPricePoint,
  MarketSnapshot,
  MarketStatus,
  Outcome,
  Position,
  SourcePost,
  Trade,
} from "../domain/types.js";

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

function positionFromRow(row: Row): Position {
  return {
    marketId: String(row.market_id),
    userId: String(row.user_id),
    yesShares: numeric(row.yes_shares),
    noShares: numeric(row.no_shares),
    netSpend: numeric(row.net_spend),
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
        outcome TEXT NOT NULL CHECK(outcome IN ('YES', 'NO')),
        credits REAL NOT NULL,
        shares REAL NOT NULL,
        price_after REAL NOT NULL,
        executed_at TEXT NOT NULL
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
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_market_price_points_market_id_id
      ON market_price_points(market_id, id);
    `);
    this.db.exec("PRAGMA optimize");
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
          creator_user_id, question, resolution_criteria, closes_at, status, resolved_outcome, resolution_sources,
          liquidity_b, yes_shares, no_shares, created_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, '[]', ?, 0, 0, ?, NULL)
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
        JSON.stringify(input.resolutionCriteria),
        input.closesAt,
        input.liquidityB,
        createdAt,
      );
      this.insertPricePoint(id, 0.5, createdAt);
      return this.getMarket(id)!;
    });
  }

  getMarket(marketId: string): Market | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE id = ?").get(marketId) as Row | undefined;
    return row ? marketFromRow(row) : null;
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

  getMarketSnapshot(marketId: string, userId?: string): MarketSnapshot {
    const market = this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
    return {
      market,
      priceYes: outcomePrice(state, "YES"),
      priceNo: outcomePrice(state, "NO"),
      position: userId ? this.getPosition(marketId, userId) : null,
    };
  }

  getPriceHistory(marketId: string, limit = 240): MarketPricePoint[] {
    const market = this.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    const rows = this.db.prepare(`
      SELECT market_id, price_yes, recorded_at FROM (
        SELECT market_id, price_yes, recorded_at, id
        FROM market_price_points WHERE market_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(marketId, limit) as Row[];
    if (rows.length === 0) {
      const state: AmmState = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
      return [{ marketId, priceYes: outcomePrice(state, "YES"), recordedAt: market.createdAt }];
    }
    return rows.map((row) => ({ marketId: String(row.market_id), priceYes: numeric(row.price_yes), recordedAt: String(row.recorded_at) }));
  }

  buy(input: { marketId: string; userId: string; outcome: Outcome; credits: number }): Trade {
    return this.transaction(() => {
      const market = this.getMarket(input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (market.status !== "OPEN") throw new ConflictError("Trading is closed for this market");
      if (new Date(market.closesAt) <= new Date()) throw new ConflictError("Trading is closed because the market deadline passed");
      const account = this.getAccount(input.userId);
      if (!account) throw new NotFoundError("Create a karma account before trading");
      if (!Number.isFinite(input.credits) || input.credits <= 0) throw new AppError("credits must be positive", 422, "INVALID_TRADE");
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
        outcome: input.outcome,
        credits: actualCost,
        shares,
        priceAfter: outcomePrice(nextState, "YES"),
        executedAt: now(),
      };

      this.db.prepare("UPDATE markets SET yes_shares = ?, no_shares = ? WHERE id = ?").run(nextYes, nextNo, market.id);
      this.insertPricePoint(market.id, trade.priceAfter, trade.executedAt);
      this.db.prepare(`
        INSERT INTO positions (market_id, user_id, yes_shares, no_shares, net_spend)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(market_id, user_id) DO UPDATE SET
          yes_shares = yes_shares + excluded.yes_shares,
          no_shares = no_shares + excluded.no_shares,
          net_spend = net_spend + excluded.net_spend
      `).run(market.id, input.userId, input.outcome === "YES" ? shares : 0, input.outcome === "NO" ? shares : 0, actualCost);
      this.db.prepare("UPDATE accounts SET available_balance = available_balance - ? WHERE x_user_id = ?").run(actualCost, input.userId);
      this.db.prepare("INSERT INTO trades (id, market_id, user_id, outcome, credits, shares, price_after, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(trade.id, trade.marketId, trade.userId, trade.outcome, trade.credits, trade.shares, trade.priceAfter, trade.executedAt);
      this.insertLedger(input.userId, market.id, "TRADE_BUY", -actualCost, `${input.outcome} shares`);
      return trade;
    });
  }

  resolve(input: { marketId: string; outcome: Outcome | null; sources: string[] }): Market {
    return this.transaction(() => {
      const market = this.getMarket(input.marketId);
      if (!market) throw new NotFoundError("Market not found");
      if (market.status !== "OPEN") throw new ConflictError("Market has already been resolved");
      if (input.outcome !== null && input.sources.length === 0) {
        throw new AppError("A YES or NO resolution needs at least one source URL", 422, "EVIDENCE_REQUIRED");
      }
      const status: MarketStatus = input.outcome === null ? "UNRESOLVABLE" : "RESOLVED";
      const resolvedAt = now();
      const positions = this.db.prepare("SELECT * FROM positions WHERE market_id = ?").all(market.id) as Row[];
      for (const rawPosition of positions) {
        const position = positionFromRow(rawPosition);
        const payout = input.outcome === null
          ? position.netSpend
          : input.outcome === "YES" ? position.yesShares : position.noShares;
        if (payout > 0) {
          this.db.prepare("UPDATE accounts SET available_balance = available_balance + ? WHERE x_user_id = ?").run(payout, position.userId);
          this.insertLedger(
            position.userId,
            market.id,
            input.outcome === null ? "UNRESOLVABLE_REFUND" : "RESOLUTION_PAYOUT",
            payout,
            input.outcome === null ? "Exact trade-spend refund" : `${input.outcome} settlement payout`,
          );
        }
      }
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

  private insertPricePoint(marketId: string, priceYes: number, recordedAt: string): void {
    this.db.prepare("INSERT INTO market_price_points (market_id, price_yes, recorded_at) VALUES (?, ?, ?)")
      .run(marketId, priceYes, recordedAt);
  }
}
