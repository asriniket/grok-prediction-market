import { describe, expect, it, vi } from "vitest";
import { calculateKarma, KARMA_CEILING, KARMA_FLOOR } from "../src/domain/karma.js";
import { validateClaimDraft } from "../src/services/claim-extractor.js";
import { costToBuy, outcomePrice, proceedsForSale, sharesForBudget } from "../src/domain/lmsr.js";
import { SqliteStore } from "../src/infrastructure/sqlite-store.js";
import type { MarketStore } from "../src/infrastructure/store.js";
import { EventBus } from "../src/services/event-bus.js";
import { MarketService } from "../src/services/market-service.js";
import { GrokMarketResolver } from "../src/services/market-resolution.js";
import type { ClaimDraft, Market, SourcePost } from "../src/domain/types.js";

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
  summary: "The market asks whether the stated launch happens by next Friday. YES depends on a qualifying official announcement by that deadline; otherwise it resolves NO.",
  resolutionCriteria: ["An official launch announcement published by the stated deadline resolves YES."],
  closesAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  rationale: "The post names a concrete event and deadline.",
};

const resolverMarket: Market = {
  id: "resolution-market",
  sourcePost,
  creatorUserId: "alice-id",
  question: claim.question,
  summary: claim.summary,
  analysis: null,
  resolutionCriteria: claim.resolutionCriteria,
  closesAt: "2026-08-08T00:00:00.000Z",
  status: "OPEN",
  resolvedOutcome: null,
  resolutionSources: [],
  liquidityB: 200,
  yesShares: 0,
  noShares: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
  resolvedAt: null,
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

describe("claim validation", () => {
  it("accepts a normalized binary question from a question-form source post", () => {
    const closesAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(validateClaimDraft({
      ...claim,
      question: "Will OpenAI release another model within the next month?",
      closesAt,
    })).toMatchObject({ question: "Will OpenAI release another model within the next month?" });
  });

  it("rejects the extractor's unresolvable sentinel and meta-market questions", () => {
    const closesAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(() => validateClaimDraft({ ...claim, question: "UNRESOLVABLE CLAIM", closesAt })).toThrow(/marketable/i);
    expect(() => validateClaimDraft({ ...claim, question: "Is this claim objectively resolvable?", closesAt })).toThrow(/marketable/i);
  });
});

describe("Grok settlement evidence", () => {
  it("forces separate web and X research before accepting a cited final verdict", async () => {
    const source = "https://example.com/official";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "web-research", output: [{ url: source }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "x-research", output: [{ url: "https://x.com/example/status/1" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "decision",
        output: [{
          type: "function_call",
          name: "report_market_resolution",
          arguments: JSON.stringify({
            outcome: "YES",
            confidence: "HIGH",
            reason: "The official announcement directly confirms the event within the stated resolution window.",
            sources: [source],
          }),
        }],
      })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await new GrokMarketResolver("test-key", "test-model").resolve(resolverMarket);
      expect(result).toMatchObject({ outcome: "YES", confidence: "HIGH", sources: [source] });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const webRequest = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
      const xRequest = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
      expect(webRequest.tools).toEqual([{ type: "web_search" }]);
      expect(xRequest).toMatchObject({ previous_response_id: "web-research", tools: [{ type: "x_search", from_date: "2026-08-01" }] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("downgrades a source-backed but non-high-confidence verdict to pending", async () => {
    const source = "https://example.com/official";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "web-research", output: [{ url: source }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "x-research", output: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: "function_call",
          name: "report_market_resolution",
          arguments: JSON.stringify({
            outcome: "NO",
            confidence: "MEDIUM",
            reason: "The evidence is suggestive, but it does not meet the threshold for automatic settlement.",
            sources: [source],
          }),
        }],
      })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(new GrokMarketResolver("test-key", "test-model").resolve(resolverMarket)).resolves.toMatchObject({ outcome: "PENDING", sources: [source] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("market briefs", () => {
  it("saves Grok's market analysis while creating a market from only the source post", async () => {
    const store = new SqliteStore(":memory:");
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus());

    const created = await markets.createMarket({ sourcePost, creatorUserId: "trader" });

    expect(created.market.question).toBe(claim.question);
    expect(created.market.summary).toBe(claim.summary);
    store.close();
  });

  it("generates a source-grounded brief once and reuses the saved value", async () => {
    const store = new SqliteStore(":memory:");
    const generate = vi.fn().mockResolvedValue("This brief explains the market using only its source post and resolution criteria.");
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus(), { generate });
    const created = await markets.createMarket({ sourcePost, creatorUserId: "trader", claim: { ...claim, summary: undefined } });

    await expect(markets.ensureSummary(created.market.id)).resolves.toMatch(/source post/i);
    await expect(markets.ensureSummary(created.market.id)).resolves.toMatch(/source post/i);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.getMarket(created.market.id)?.summary).toMatch(/source post/i);
    store.close();
  });
});

describe("market AI analysis", () => {
  it("caches the X pulse separately from the source-derived market setup", async () => {
    const store = new SqliteStore(":memory:");
    const analysis = {
      body: "Pulse: Relevant X posts point to a pending product update, but the signal is still incomplete.\n\nCatalysts: An official announcement would materially strengthen the case.\n\nCounter-signals: No official release has been posted yet.\n\nWatch: The next official product announcement.",
      sources: ["https://x.com/example/status/1"],
      posts: [{
        url: "https://x.com/example/status/1",
        handle: "example",
        text: "A relevant example post supporting the market pulse.",
        createdAt: "Aug 8",
        relevance: "Relevant because it discusses the pending product update.",
      }],
      generatedAt: "2026-08-08T00:00:00.000Z",
    };
    const refreshedAnalysis = {
      ...analysis,
      body: "Pulse: The refreshed X search found a newer public discussion point, but the signal remains incomplete.\n\nCatalysts: An official announcement would materially strengthen the case.\n\nCounter-signals: No official release has been posted yet.\n\nWatch: The next official product announcement.",
      generatedAt: "2026-08-08T01:00:00.000Z",
    };
    const generate = vi.fn().mockResolvedValueOnce(analysis).mockResolvedValueOnce(refreshedAnalysis);
    const markets = new MarketService(
      store as unknown as MarketStore,
      { extract: async () => claim },
      new EventBus(),
      undefined,
      { generate },
    );
    const created = await markets.createMarket({ sourcePost, creatorUserId: "trader" });

    await expect(markets.ensureAnalysis(created.market.id)).resolves.toEqual(analysis);
    await expect(markets.ensureAnalysis(created.market.id)).resolves.toEqual(analysis);
    await expect(markets.ensureAnalysis(created.market.id, true)).resolves.toEqual(refreshedAnalysis);
    await expect(markets.ensureAnalysis(created.market.id)).resolves.toEqual(refreshedAnalysis);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(store.getMarket(created.market.id)?.analysis).toEqual(refreshedAnalysis);
    store.close();
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
    await markets.resolve({ marketId: created.market.id, outcome: null, sources: ["https://example.com/unresolvable"] });
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
    await markets.resolve({ marketId: second.market.id, outcome: null, sources: ["https://example.com/unresolvable"] });
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(beforeRefundTrade, 8);
    store.close();
  });

  it("clears positions after one source-backed payout and rejects a second settlement", async () => {
    const store = new SqliteStore(":memory:");
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus());
    await markets.createAccount({ xUserId: "trader", handle: "trader", accountCreatedAt: "2026-08-07T00:00:00.000Z", postCount: 0, impressionSamples: [] });
    const created = await markets.createMarket({ sourcePost, creatorUserId: "trader", claim });
    await markets.trade({ marketId: created.market.id, userId: "trader", outcome: "YES", credits: 10 });

    await expect(markets.resolve({ marketId: created.market.id, outcome: "YES", sources: [] })).rejects.toThrow(/source/i);
    await markets.resolve({ marketId: created.market.id, outcome: "YES", sources: ["https://example.com/official"] });
    expect(store.getPosition(created.market.id, "trader")).toMatchObject({ yesShares: 0, noShares: 0, netSpend: 0 });
    await expect(markets.resolve({ marketId: created.market.id, outcome: "YES", sources: ["https://example.com/official"] })).rejects.toThrow(/already been resolved/i);
    store.close();
  });
});

describe("idempotent execution and Grok settlement", () => {
  it("applies a buy or early cash-out only once for a retried request", async () => {
    const store = new SqliteStore(":memory:");
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus());
    await markets.createAccount({ xUserId: "trader", handle: "trader", accountCreatedAt: "2026-08-07T00:00:00.000Z", postCount: 0, impressionSamples: [] });
    const created = await markets.createMarket({ sourcePost, creatorUserId: "trader", claim });
    const openingBalance = store.getAccount("trader")!.availableBalance;
    const buyKey = "75c623ae-2f19-48a9-a665-d2de3832382c";
    const firstBuy = await markets.trade({ marketId: created.market.id, userId: "trader", outcome: "YES", credits: 20, idempotencyKey: buyKey });
    const retryBuy = await markets.trade({ marketId: created.market.id, userId: "trader", outcome: "YES", credits: 20, idempotencyKey: buyKey });
    expect(retryBuy.id).toBe(firstBuy.id);
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(openingBalance - firstBuy.credits, 8);
    await expect(markets.trade({ marketId: created.market.id, userId: "trader", outcome: "YES", credits: 21, idempotencyKey: buyKey })).rejects.toThrow(/idempotency/i);

    const sellKey = "5eea2e7f-0dc0-44eb-a30d-9c73fb6aefb3";
    const firstSell = await markets.sell({ marketId: created.market.id, userId: "trader", outcome: "YES", shares: firstBuy.shares / 2, idempotencyKey: sellKey });
    const retrySell = await markets.sell({ marketId: created.market.id, userId: "trader", outcome: "YES", shares: firstBuy.shares / 2, idempotencyKey: sellKey });
    expect(retrySell.id).toBe(firstSell.id);
    expect(store.getPosition(created.market.id, "trader")!.yesShares).toBeCloseTo(firstBuy.shares - firstSell.shares, 8);
    store.close();
  });

  it("settles only a due market with Grok's high-confidence, source-backed verdict", async () => {
    const store = new SqliteStore(":memory:");
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        outcome: "YES",
        confidence: "HIGH",
        reason: "An official source directly confirms the event before the resolution deadline.",
        sources: ["https://example.com/official"],
      }),
    };
    const markets = new MarketService(
      store as unknown as MarketStore,
      { extract: async () => claim },
      new EventBus(),
      undefined,
      undefined,
      resolver,
    );
    await markets.createAccount({ xUserId: "trader", handle: "trader", accountCreatedAt: "2026-08-07T00:00:00.000Z", postCount: 0, impressionSamples: [] });
    const closesAt = new Date(Date.now() + 60_000).toISOString();
    const created = store.createMarket({
      sourcePost: { ...sourcePost, id: "due-market", url: "https://x.com/alice/status/due-market" },
      creatorUserId: "trader",
      question: claim.question,
      summary: claim.summary,
      resolutionCriteria: claim.resolutionCriteria,
      closesAt,
      liquidityB: 200,
    });
    const openingBalance = store.getAccount("trader")!.availableBalance;
    const trade = await markets.trade({ marketId: created.id, userId: "trader", outcome: "YES", credits: 10 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(new Date(closesAt).valueOf() + 1));
    let result;
    try {
      result = await markets.resolveWithGrok(created.id);
    } finally {
      vi.useRealTimers();
    }

    expect(result).toMatchObject({ settled: true, decision: { outcome: "YES" }, market: { status: "RESOLVED", resolvedOutcome: "YES" } });
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(store.getAccount("trader")!.availableBalance).toBeCloseTo(openingBalance - trade.credits + trade.shares, 8);
    store.close();
  });

  it("keeps the market open when Grok reports pending evidence", async () => {
    const store = new SqliteStore(":memory:");
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        outcome: "PENDING",
        confidence: "LOW",
        reason: "The available sources do not yet establish the result under the stated resolution criteria.",
        sources: [],
      }),
    };
    const markets = new MarketService(store as unknown as MarketStore, { extract: async () => claim }, new EventBus(), undefined, undefined, resolver);
    const created = store.createMarket({
      sourcePost: { ...sourcePost, id: "pending-market", url: "https://x.com/alice/status/pending-market" },
      creatorUserId: "trader",
      question: claim.question,
      summary: claim.summary,
      resolutionCriteria: claim.resolutionCriteria,
      closesAt: new Date(Date.now() - 60_000).toISOString(),
      liquidityB: 200,
    });

    await expect(markets.resolveWithGrok(created.id)).resolves.toMatchObject({ settled: false, decision: { outcome: "PENDING" } });
    expect(store.getMarket(created.id)).toMatchObject({ status: "OPEN", resolvedOutcome: null });
    store.close();
  });
});
