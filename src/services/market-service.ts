import { AppError } from "../domain/errors.js";
import { outcomePrice } from "../domain/lmsr.js";
import type { AccountHistoryInput, ClaimDraft, Outcome, SourcePost } from "../domain/types.js";
import type { MarketStore } from "../infrastructure/store.js";
import type { ClaimExtractor } from "./claim-extractor.js";
import { validateClaimDraft } from "./claim-extractor.js";
import { EventBus } from "./event-bus.js";

const DEFAULT_LIQUIDITY_B = 200;

export class MarketService {
  constructor(
    private readonly store: MarketStore,
    private readonly extractor: ClaimExtractor,
    private readonly events: EventBus,
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
