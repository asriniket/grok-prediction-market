import { AppError } from "./errors.js";
import type { AccountHistoryInput } from "./types.js";

export const KARMA_FLOOR = 100;
export const KARMA_CEILING = 5_000;
const MAX_AGE_YEARS = 15;
const MAX_POST_COUNT = 100_000;
const MAX_MEDIAN_IMPRESSIONS = 100_000;

export interface KarmaBreakdown {
  ageYears: number;
  medianImpressions: number | null;
  sampleSize: number;
  ageFactor: number;
  postFactor: number;
  reachFactor: number;
  seed: number;
}

function boundedLogFactor(value: number, cap: number): number {
  return 1 + Math.log10(1 + Math.min(Math.max(value, 0), cap));
}

export function median(values: number[]): number | null {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 === 0 ? (valid[middle - 1] + valid[middle]) / 2 : valid[middle];
}

/**
 * Public-history seed only. It is frozen after first creation; trading P&L is
 * the ongoing score. Caps make the 50:1 product claim mechanically true.
 */
export function calculateKarma(history: AccountHistoryInput, now = new Date()): KarmaBreakdown {
  const createdAt = new Date(history.accountCreatedAt);
  if (Number.isNaN(createdAt.valueOf()) || createdAt > now) {
    throw new AppError("accountCreatedAt must be a valid past ISO timestamp", 422, "INVALID_HISTORY");
  }
  if (!Number.isSafeInteger(history.postCount) || history.postCount < 0) {
    throw new AppError("postCount must be a non-negative integer", 422, "INVALID_HISTORY");
  }

  const ageYears = Math.max(0, (now.valueOf() - createdAt.valueOf()) / (365.2425 * 24 * 60 * 60 * 1000));
  const medianImpressions = median(history.impressionSamples);
  const ageFactor = boundedLogFactor(ageYears, MAX_AGE_YEARS);
  const postFactor = boundedLogFactor(history.postCount, MAX_POST_COUNT);
  // Missing samples receive no reach uplift. This avoids treating unavailable
  // analytics as evidence of reach.
  const reachFactor = medianImpressions === null ? 1 : boundedLogFactor(medianImpressions, MAX_MEDIAN_IMPRESSIONS);
  const seed = Math.round(Math.min(KARMA_CEILING, Math.max(KARMA_FLOOR, KARMA_FLOOR * ageFactor * postFactor * reachFactor)) * 100) / 100;

  return { ageYears, medianImpressions, sampleSize: history.impressionSamples.length, ageFactor, postFactor, reachFactor, seed };
}
