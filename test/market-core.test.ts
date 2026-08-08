import { describe, expect, it } from "vitest";
import { calculateKarma, KARMA_CEILING, KARMA_FLOOR } from "../src/domain/karma.js";
import { costToBuy, outcomePrice, proceedsForSale, sharesForBudget } from "../src/domain/lmsr.js";
import { SqliteStore } from "../src/infrastructure/sqlite-store.js";
import type { MarketStore } from "../src/infrastructure/store.js";
import { EventBus } from "../src/services/event-bus.js";
import { MarketService } from "../src/services/market-service.js";
import type { ClaimDraft, SourcePost } from "../src/domain/types.js";

const sourcePost: SourcePost = {
  id: "123",
  url: "https://x.com/alice/status/123",
  text: "The launch will happen by next Friday.",
  authorId: "alice-id",
  authorHandle: "alice",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const claim: ClaimDraft = {
  question: "Will the launch happen by next Friday?",
  resolutionCriteria: ["An official launch announcement published by the stated deadline resolves YES."],
  closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  rationale: "The post names a concrete event and deadline.",
};

describe("karma seeding", () => {
  it("has a real 50:1 bound and makes missing reach conservative", () => {
    const fresh = calculateKarma({
      xUserId: "fresh",
      handle: "fresh",
      accountCreatedAt: new Date().toISOString(),
      postCount: 0,
      impressionSamples: [],
    });
    const established = calculateKarma({
      xUserId: "established",
      handle: "established",
      accountCreatedAt: "2008-01-01T00:00:00.000Z",
      postCount: 2_000_000,
      impressionSamples: [9_999_999, 2_000_000, 1_000_000],
    });
    expect(fresh.seed).toBe(KARMA_FLOOR);
    expect(established.seed).toBe(KARMA_CEILING);
    expect(established.seed / fresh.seed).toBeLessThanOrEqual(50);
  });
});

describe("LMSR", () => {
  it("moves price and never spends more than a supplied budget", () => {
    const state = { liquidityB: 200, yesShares: 0, noShares: 0 };
    const purchase = sharesForBudget(state, "YES", 25);
    expect(purchase.actualCost).toBeLessThanOrEqual(25);
    expect(purchase.shares).toBeGreaterThan(0);
    expect(outcomePrice({ ...state, yesShares: purchase.shares }, "YES")).toBeGreaterThan(0.5);
    expect(costToBuy(state, "YES", purchase.shares)).toBeCloseTo(purchase.actualCost, 8);
    expect(proceedsForSale({ ...state, yesShares: purchase.shares }, "YES", purchase.shares)).toBeCloseTo(purchase.actualCost, 8);
  });
});

describe("market exits", () => {
  it("lets a holder partially sell, credits the current AMM proceeds, and blocks short sales", async () => {
    const store = new SqliteStore(":memory:");
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus());
    await markets.createAccount({
      xUserId: "trader",
      handle: "trader",
      accountCreatedAt: "2026-08-07T00:00:00.000Z",
      postCount: 0,
      impressionSamples: [],
    });
    const created = await markets.createMarket({ sourcePost, creatorUserId: "trader", claim });
    const initialBalance = store.getAccount("trader")!.availableBalance;
    const buy = await markets.trade({ marketId: created.market.id, userId: "trader", outcome: "YES", credits: 20 });
    const beforeSellPrice = store.getMarketSnapshot(created.market.id, "trader").priceYes;
    const sale = await markets.sell({ marketId: created.market.id, userId: "trader", outcome: "YES", shares: buy.shares / 2 });
    const snapshot = store.getMarketSnapshot(created.market.id, "trader");

    expect(sale.side).toBe("SELL");
    expect(sale.credits).toBeGreaterThan(0);
    expect(snapshot.position!.yesShares).toBeCloseTo(buy.shares / 2, 8);
    expect(snapshot.priceYes).toBeLessThan(beforeSellPrice);
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(initialBalance - buy.credits + sale.credits, 8);
    expect(store.getPriceHistory(created.market.id)).toHaveLength(3);
    await expect(markets.sell({ marketId: created.market.id, userId: "trader", outcome: "YES", shares: buy.shares })).rejects.toThrow(/only hold/i);
    store.close();
  });

  it("does not debit a trader when an unresolvable market follows a fully exited position", async () => {
    const store = new SqliteStore(":memory:");
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus());
    for (const xUserId of ["first", "second"]) {
      await markets.createAccount({ xUserId, handle: xUserId, accountCreatedAt: "2026-08-07T00:00:00.000Z", postCount: 0, impressionSamples: [] });
    }
    const created = await markets.createMarket({ sourcePost, creatorUserId: "first", claim });
    const opening = store.getAccount("first")!.availableBalance;
    const firstBuy = await markets.trade({ marketId: created.market.id, userId: "first", outcome: "YES", credits: 10 });
    await markets.trade({ marketId: created.market.id, userId: "second", outcome: "YES", credits: 90 });
    const firstSale = await markets.sell({ marketId: created.market.id, userId: "first", outcome: "YES", shares: firstBuy.shares });
    expect(firstSale.credits).toBeGreaterThan(firstBuy.credits);
    const afterExit = store.getAccount("first")!.availableBalance;
    await markets.resolve({ marketId: created.market.id, outcome: null, sources: [] });
    expect(store.getAccount("first")!.availableBalance).toBeCloseTo(afterExit, 8);
    expect(afterExit).toBeGreaterThan(opening);
    store.close();
  });
});

describe("market settlement", () => {
  it("pays the winning shares and exactly refunds an unresolvable market", async () => {
    const store = new SqliteStore(":memory:");
    const extractor = { extract: async () => claim };
    const markets = new MarketService(store as unknown as MarketStore, extractor, new EventBus());
    await markets.createAccount({
      xUserId: "trader",
      handle: "trader",
      accountCreatedAt: "2026-08-07T00:00:00.000Z",
      postCount: 0,
      impressionSamples: [],
    });
    const initialBalance = store.getAccount("trader")!.availableBalance;
    const first = await markets.createMarket({ sourcePost, creatorUserId: "trader", claim });
    expect(store.getPriceHistory(first.market.id)).toEqual([
      expect.objectContaining({ marketId: first.market.id, priceYes: 0.5 }),
    ]);
    const trade = await markets.trade({ marketId: first.market.id, userId: "trader", outcome: "YES", credits: 10 });
    const priceHistory = store.getPriceHistory(first.market.id);
    expect(priceHistory).toHaveLength(2);
    expect(priceHistory.at(-1)!.priceYes).toBeGreaterThan(0.5);
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(initialBalance - trade.credits, 8);
    await markets.resolve({ marketId: first.market.id, outcome: "YES", sources: ["https://example.com/official"] });
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(initialBalance - trade.credits + trade.shares, 8);

    const second = await markets.createMarket({ sourcePost: { ...sourcePost, id: "124", url: "https://x.com/alice/status/124" }, creatorUserId: "trader", claim });
    const beforeRefundTrade = store.getAccount("trader")!.availableBalance;
    await markets.trade({ marketId: second.market.id, userId: "trader", outcome: "NO", credits: 7 });
    await markets.resolve({ marketId: second.market.id, outcome: null, sources: [] });
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(beforeRefundTrade, 8);
    store.close();
  });
});
