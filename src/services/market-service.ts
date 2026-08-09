import { AppError, NotFoundError } from "../domain/errors.js";
import { outcomePrice } from "../domain/lmsr.js";
import type { AccountHistoryInput, ClaimDraft, MarketAnalysis, Outcome, SourcePost } from "../domain/types.js";
import type { MarketStore } from "../infrastructure/store.js";
import type { ClaimExtractor } from "./claim-extractor.js";
import { validateClaimDraft } from "./claim-extractor.js";
import { EventBus } from "./event-bus.js";
import { UnavailableMarketAnalysisGenerator, type MarketAnalysisGenerator } from "./market-analysis.js";
import { UnavailableMarketSummaryGenerator, type MarketSummaryGenerator } from "./market-summary.js";

const DEFAULT_LIQUIDITY_B = 200;

export class MarketService {
  private readonly pendingSummaries = new Map<string, Promise<string>>();
  private readonly pendingAnalyses = new Map<string, Promise<MarketAnalysis>>();
  private readonly lastDemoBroadcastAt = new Map<string, number>();

  constructor(
    private readonly store: MarketStore,
    private readonly extractor: ClaimExtractor,
    private readonly events: EventBus,
    private readonly summaries: MarketSummaryGenerator = new UnavailableMarketSummaryGenerator(),
    private readonly analyses: MarketAnalysisGenerator = new UnavailableMarketAnalysisGenerator(),
  ) {}

  async createAccount(history: AccountHistoryInput) {
    const result = await this.store.createAccountIfAbsent(history);
    if (result.created) this.events.publish({ type: "account.seeded", payload: { account: result.account } });
    return result;
  }

  async createMarket(input: {
    sourcePost: SourcePost;
    creatorUserId: string;
    claim?: ClaimDraft;
    liquidityB?: number;
  }) {
    const existing = await this.store.getMarketBySourcePost(input.sourcePost.id);
    if (existing) return { market: existing, created: false };
    const claim = validateClaimDraft(input.claim ?? await this.extractor.extract(input.sourcePost));
    const liquidityB = input.liquidityB ?? DEFAULT_LIQUIDITY_B;
    if (!Number.isFinite(liquidityB) || liquidityB < 25 || liquidityB > 100_000) {
      throw new AppError("liquidityB must be between 25 and 100000", 422, "INVALID_LIQUIDITY");
    }
    const market = await this.store.createMarket({ ...input, ...claim, liquidityB });
    this.events.publish({
      type: "market.created",
      marketId: market.id,
      payload: {
        market,
        priceYes: 0.5,
        priceNo: 0.5,
        // Partner-facing invariant: renderer is responsible for equal visual treatment.
        presentationPolicy: "symmetric_scaffold_required",
      },
    });
    return { market, created: true };
  }

  /** Lazily generates and caches a factual market brief the first time it is viewed. */
  async ensureSummary(marketId: string): Promise<string> {
    const market = await this.store.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    if (market.summary) return market.summary;

    const pending = this.pendingSummaries.get(marketId);
    if (pending) return pending;

    const work = this.summaries.generate(market)
      .then((summary) => this.store.saveMarketSummary(marketId, summary))
      .finally(() => this.pendingSummaries.delete(marketId));
    this.pendingSummaries.set(marketId, work);
    return work;
  }

  /** Searches X once, then caches a richer context layer separately from resolution rules. */
  async ensureAnalysis(marketId: string, refresh = false): Promise<MarketAnalysis> {
    const market = await this.store.getMarket(marketId);
    if (!market) throw new NotFoundError("Market not found");
    if (market.analysis && market.analysis.posts.length > 0 && !refresh) return market.analysis;

    // A manual refresh must never be folded into the page's initial cache fill:
    // callers expect it to run a fresh X Search. The two writes are safe because
    // the non-refresh write only fills an empty value while refresh replaces it.
    const pendingKey = `${marketId}:${refresh ? "refresh" : "initial"}`;
    const pending = this.pendingAnalyses.get(pendingKey);
    if (pending) return pending;

    const work = this.analyses.generate(market)
      .then((analysis) => this.store.saveMarketAnalysis(marketId, analysis, refresh))
      .finally(() => this.pendingAnalyses.delete(pendingKey));
    this.pendingAnalyses.set(pendingKey, work);
    return work;
  }

  async trade(input: { marketId: string; userId: string; outcome: Outcome; credits: number }) {
    const trade = await this.store.buy(input);
    const market = (await this.store.getMarket(input.marketId))!;
    const state = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
    this.events.publish({
      type: "market.trade.executed",
      marketId: input.marketId,
      payload: { trade, priceYes: outcomePrice(state, "YES"), priceNo: outcomePrice(state, "NO") },
    });
    return trade;
  }

  async sell(input: { marketId: string; userId: string; outcome: Outcome; shares: number }) {
    const trade = await this.store.sell(input);
    const market = (await this.store.getMarket(input.marketId))!;
    const state = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
    this.events.publish({
      type: "market.trade.executed",
      marketId: input.marketId,
      payload: { trade, priceYes: outcomePrice(state, "YES"), priceNo: outcomePrice(state, "NO") },
    });
    return trade;
  }

  async applyDemoFlow(marketId: string, outcome: Outcome, shares: number) {
    const pulse = await this.store.applyDemoFlow({ marketId, outcome, shares });
    if (!pulse) return null;
    // The simulator may make sub-second moves. Publishing every one makes each
    // connected market page refetch its whole snapshot and can overload a
    // small local database. The next event always carries the latest price.
    const now = Date.now();
    const previous = this.lastDemoBroadcastAt.get(marketId) ?? 0;
    if (now - previous < 1_500) return pulse;
    this.lastDemoBroadcastAt.set(marketId, now);
    this.events.publish({
      type: "market.demo.pulse",
      marketId,
      payload: { ...pulse, metrics: await this.store.getMarketMetrics(marketId), demo: true },
    });
    return pulse;
  }

  async resolve(input: { marketId: string; outcome: Outcome | null; sources: string[] }) {
    const market = await this.store.resolve(input);
    this.events.publish({ type: "market.resolved", marketId: market.id, payload: { market } });
    return market;
  }
}
