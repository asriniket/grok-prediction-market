import type { Outcome } from "../domain/types.js";
import { MarketService } from "./market-service.js";
import type { MarketStore } from "../infrastructure/store.js";

/**
 * Local-only visual order flow for a hackathon demo. It is deliberately kept
 * separate from trader wallets, and every resulting point is marked DEMO in
 * the history API and UI. This gives a fresh market a live signal without
 * fabricating users, deposits, or trade volume.
 */
export class DemoMarketPulse {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: MarketStore,
    private readonly markets: MarketService,
    private readonly intervalMs = 12_000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    for (const market of await this.store.listMarkets(50)) {
      if (market.status !== "OPEN" || new Date(market.closesAt) <= new Date()) continue;
      const snapshot = await this.store.getMarketSnapshot(market.id);
      const outcome: Outcome = this.nextOutcome(snapshot.priceYes);
      // The size is intentionally small compared with the default 200-credit
      // depth: a demo pulse is a signal, not a substitute for participant flow.
      const shares = 3 + Math.random() * 7;
      await this.markets.applyDemoFlow(market.id, outcome, shares);
    }
  }

  private nextOutcome(yesPrice: number): Outcome {
    // Gentle mean reversion keeps an unattended local demo legible instead of
    // pinning it at 0% or 100%, while leaving each individual tick uncertain.
    const yesBias = Math.min(0.68, Math.max(0.32, 0.5 + (0.5 - yesPrice) * 0.7));
    return Math.random() < yesBias ? "YES" : "NO";
  }
}
