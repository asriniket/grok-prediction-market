import type { Outcome } from "../domain/types.js";
import { MarketService } from "./market-service.js";
import type { MarketStore } from "../infrastructure/store.js";

type ActivityRegime = "quiet" | "active" | "news";

interface PulseState {
  fairLogit: number;
  orderImbalance: number;
  regime: ActivityRegime;
  remainingTicks: number;
}

const MIN_PRICE = 0.055;
const MAX_PRICE = 0.945;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function logit(probability: number): number {
  const safe = clamp(probability, MIN_PRICE, MAX_PRICE);
  return Math.log(safe / (1 - safe));
}

function normal(): number {
  // Box–Muller gives a much more natural distribution of small moves with
  // occasional larger ones than a uniform random nudge.
  const first = Math.max(Number.EPSILON, Math.random());
  const second = Math.random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function range(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * A local-only market microstructure simulator. It produces irregular order
 * flow with clustered activity, momentum, fair-value pull, and rare repricing
 * bursts. Every generated point remains marked DEMO; it neither creates users
 * nor changes a participant's wallet.
 */
export class DemoMarketPulse {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly states = new Map<string, PulseState>();
  /** A slow database read must never let reconcile start a second pulse for the same market. */
  private readonly inFlight = new Set<string>();
  private discoveryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: MarketStore,
    private readonly markets: MarketService,
  ) {}

  start(): void {
    if (this.discoveryTimer) return;
    void this.reconcile().catch(() => undefined);
    this.discoveryTimer = setInterval(() => void this.reconcile().catch(() => undefined), 15_000);
    this.discoveryTimer.unref();
  }

  stop(): void {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.states.clear();
    this.inFlight.clear();
  }

  private async reconcile(): Promise<void> {
    const openMarkets = (await this.store.listMarkets(50)).filter((market) => market.status === "OPEN" && new Date(market.closesAt) > new Date());
    const openIds = new Set(openMarkets.map((market) => market.id));
    for (const marketId of this.timers.keys()) {
      if (!openIds.has(marketId)) {
        clearTimeout(this.timers.get(marketId)!);
        this.timers.delete(marketId);
        this.states.delete(marketId);
      }
    }
    for (const market of openMarkets) {
      if (!this.timers.has(market.id) && !this.inFlight.has(market.id)) {
        this.schedule(market.id, range(450, 1800));
      }
    }
  }

  private schedule(marketId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(marketId);
      void this.pulse(marketId);
    }, delayMs);
    timer.unref();
    this.timers.set(marketId, timer);
  }

  private async pulse(marketId: string): Promise<void> {
    // Timers are removed immediately before work starts. Keep an explicit
    // in-flight marker so the 15-second reconciler cannot schedule a duplicate
    // pulse while a database request is still pending.
    if (this.inFlight.has(marketId)) return;
    this.inFlight.add(marketId);
    let state = this.states.get(marketId);
    try {
      const snapshot = await this.store.getMarketSnapshot(marketId);
      if (snapshot.market.status !== "OPEN" || new Date(snapshot.market.closesAt) <= new Date()) {
        this.states.delete(marketId);
        return;
      }
      const currentLogit = logit(snapshot.priceYes);
      state ??= {
        fairLogit: currentLogit,
        orderImbalance: 0,
        regime: "quiet",
        remainingTicks: 0,
      };
      this.advanceRegime(state);

      const volatility = state.regime === "news" ? 0.105 : state.regime === "active" ? 0.046 : 0.018;
      const jump = state.regime === "news" && Math.random() < 0.22
        ? (Math.random() < 0.5 ? -1 : 1) * range(0.045, 0.13)
        : 0;
      state.fairLogit = clamp(state.fairLogit + normal() * volatility + jump, logit(MIN_PRICE), logit(MAX_PRICE));
      state.orderImbalance = clamp(
        state.orderImbalance * 0.62 + (state.fairLogit - currentLogit) * 0.24 + normal() * volatility * 0.75,
        -0.18,
        0.18,
      );
      const move = clamp(state.orderImbalance + normal() * volatility * 0.28, -0.19, 0.19);
      const nextLogit = clamp(currentLogit + move, logit(MIN_PRICE), logit(MAX_PRICE));
      const outcome: Outcome = nextLogit >= currentLogit ? "YES" : "NO";
      const shares = Math.max(1.2, Math.abs(nextLogit - currentLogit) * snapshot.market.liquidityB);
      const pulse = await this.markets.applyDemoFlow(marketId, outcome, shares);
      if (!pulse) {
        this.states.delete(marketId);
        return;
      }
      this.states.set(marketId, state);
    } catch {
      // A transient database reconnect should not terminate the local demo loop.
    } finally {
      this.inFlight.delete(marketId);
      if (this.states.has(marketId) && !this.timers.has(marketId)) {
        this.schedule(marketId, this.nextDelay(state?.regime ?? "quiet"));
      }
    }
  }

  private advanceRegime(state: PulseState): void {
    if (state.remainingTicks > 0) {
      state.remainingTicks -= 1;
      return;
    }
    const sample = Math.random();
    if (sample < 0.055) {
      state.regime = "news";
      state.remainingTicks = Math.floor(range(2, 6));
    } else if (sample < 0.33) {
      state.regime = "active";
      state.remainingTicks = Math.floor(range(3, 9));
    } else {
      state.regime = "quiet";
      state.remainingTicks = Math.floor(range(1, 5));
    }
  }

  private nextDelay(regime: ActivityRegime): number {
    if (regime === "news") return range(420, 1_250);
    if (regime === "active") return range(1_100, 3_600);
    return range(4_500, 13_500);
  }
}
