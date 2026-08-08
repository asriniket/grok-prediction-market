import { AppError } from "../domain/errors.js";
import { outcomePrice } from "../domain/lmsr.js";
import type { AccountHistoryInput, ClaimDraft, Outcome, SourcePost } from "../domain/types.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import type { ClaimExtractor } from "./claim-extractor.js";
import { validateClaimDraft } from "./claim-extractor.js";
import { EventBus } from "./event-bus.js";

const DEFAULT_LIQUIDITY_B = 200;

export class MarketService {
  constructor(
    private readonly store: SqliteStore,
    private readonly extractor: ClaimExtractor,
    private readonly events: EventBus,
  ) {}

  createAccount(history: AccountHistoryInput) {
    const result = this.store.createAccountIfAbsent(history);
    if (result.created) this.events.publish({ type: "account.seeded", payload: { account: result.account } });
    return result;
  }

  async createMarket(input: {
    sourcePost: SourcePost;
    creatorUserId: string;
    claim?: ClaimDraft;
    liquidityB?: number;
  }) {
    const existing = this.store.getMarketBySourcePost(input.sourcePost.id);
    if (existing) return { market: existing, created: false };
    const claim = validateClaimDraft(input.claim ?? await this.extractor.extract(input.sourcePost));
    const liquidityB = input.liquidityB ?? DEFAULT_LIQUIDITY_B;
    if (!Number.isFinite(liquidityB) || liquidityB < 25 || liquidityB > 100_000) {
      throw new AppError("liquidityB must be between 25 and 100000", 422, "INVALID_LIQUIDITY");
    }
    const market = this.store.createMarket({ ...input, ...claim, liquidityB });
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

  trade(input: { marketId: string; userId: string; outcome: Outcome; credits: number }) {
    const trade = this.store.buy(input);
    const market = this.store.getMarket(input.marketId)!;
    const state = { liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares };
    this.events.publish({
      type: "market.trade.executed",
      marketId: input.marketId,
      payload: { trade, priceYes: outcomePrice(state, "YES"), priceNo: outcomePrice(state, "NO") },
    });
    return trade;
  }

  resolve(input: { marketId: string; outcome: Outcome | null; sources: string[] }) {
    const market = this.store.resolve(input);
    this.events.publish({ type: "market.resolved", marketId: market.id, payload: { market } });
    return market;
  }
}
