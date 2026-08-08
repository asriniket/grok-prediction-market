import { AppError } from "./errors.js";
import type { Outcome } from "./types.js";

export interface AmmState {
  liquidityB: number;
  yesShares: number;
  noShares: number;
}

function assertState(state: AmmState): void {
  if (!Number.isFinite(state.liquidityB) || state.liquidityB <= 0) {
    throw new AppError("liquidityB must be positive", 422, "INVALID_AMM");
  }
  if (!Number.isFinite(state.yesShares) || !Number.isFinite(state.noShares) || state.yesShares < 0 || state.noShares < 0) {
    throw new AppError("share quantities must be finite and non-negative", 422, "INVALID_AMM");
  }
}

/** Numerically stable LMSR cost function for a binary market. */
export function lmsrCost(state: AmmState): number {
  assertState(state);
  const yes = state.yesShares / state.liquidityB;
  const no = state.noShares / state.liquidityB;
  const maximum = Math.max(yes, no);
  return state.liquidityB * (maximum + Math.log(Math.exp(yes - maximum) + Math.exp(no - maximum)));
}

export function outcomePrice(state: AmmState, outcome: Outcome): number {
  assertState(state);
  const difference = (state.yesShares - state.noShares) / state.liquidityB;
  const yes = difference >= 0 ? 1 / (1 + Math.exp(-difference)) : Math.exp(difference) / (1 + Math.exp(difference));
  return outcome === "YES" ? yes : 1 - yes;
}

export function costToBuy(state: AmmState, outcome: Outcome, shares: number): number {
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new AppError("shares must be positive", 422, "INVALID_TRADE");
  }
  const next = outcome === "YES"
    ? { ...state, yesShares: state.yesShares + shares }
    : { ...state, noShares: state.noShares + shares };
  return lmsrCost(next) - lmsrCost(state);
}

/**
 * The credits returned when a holder exits shares back into the AMM. A sale can
 * only remove shares that are present in the market state; caller-specific
 * ownership checks live in the store transaction.
 */
export function proceedsForSale(state: AmmState, outcome: Outcome, shares: number): number {
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new AppError("shares must be positive", 422, "INVALID_TRADE");
  }
  const outstanding = outcome === "YES" ? state.yesShares : state.noShares;
  if (shares > outstanding + 1e-8) {
    throw new AppError("cannot sell more shares than the market holds", 422, "INVALID_TRADE");
  }
  const next = outcome === "YES"
    ? { ...state, yesShares: Math.max(0, state.yesShares - shares) }
    : { ...state, noShares: Math.max(0, state.noShares - shares) };
  return lmsrCost(state) - lmsrCost(next);
}

/**
 * Converts a safe spend budget into shares. Bisection prevents a client from
 * exploiting a stale quoted price and guarantees actual debit never exceeds it.
 */
export function sharesForBudget(state: AmmState, outcome: Outcome, credits: number): { shares: number; actualCost: number } {
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new AppError("credits must be a positive number", 422, "INVALID_TRADE");
  }
  let low = 0;
  let high = Math.max(1, credits / Math.max(outcomePrice(state, outcome), 0.000001));
  while (costToBuy(state, outcome, high) < credits) {
    high *= 2;
    if (high > 1e12) throw new AppError("trade is too large", 422, "INVALID_TRADE");
  }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (costToBuy(state, outcome, middle) <= credits) low = middle;
    else high = middle;
  }
  return { shares: low, actualCost: costToBuy(state, outcome, low) };
}
