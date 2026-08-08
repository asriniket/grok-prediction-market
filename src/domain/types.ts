export const OUTCOMES = ["YES", "NO"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const MARKET_STATUSES = ["OPEN", "RESOLVED", "UNRESOLVABLE"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];

export interface SourcePost {
  id: string;
  url: string;
  text: string;
  authorId: string;
  authorHandle: string;
  createdAt: string;
}

export interface ClaimDraft {
  question: string;
  resolutionCriteria: string[];
  closesAt: string;
  rationale: string;
}

export interface Market {
  id: string;
  sourcePost: SourcePost;
  creatorUserId: string;
  question: string;
  resolutionCriteria: string[];
  closesAt: string;
  status: MarketStatus;
  resolvedOutcome: Outcome | null;
  resolutionSources: string[];
  liquidityB: number;
  yesShares: number;
  noShares: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Position {
  marketId: string;
  userId: string;
  yesShares: number;
  noShares: number;
  netSpend: number;
}

export interface AccountHistoryInput {
  xUserId: string;
  handle: string;
  accountCreatedAt: string;
  postCount: number;
  impressionSamples: number[];
}

export interface Account {
  xUserId: string;
  handle: string;
  accountCreatedAt: string;
  postCount: number;
  medianImpressions: number | null;
  impressionSampleSize: number;
  karmaSeed: number;
  availableBalance: number;
  createdAt: string;
}

export interface Trade {
  id: string;
  marketId: string;
  userId: string;
  outcome: Outcome;
  credits: number;
  shares: number;
  priceAfter: number;
  executedAt: string;
}

export interface MarketSnapshot {
  market: Market;
  priceYes: number;
  priceNo: number;
  position: Position | null;
}

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type:
    | "market.created"
    | "market.trade.executed"
    | "market.resolved"
    | "account.seeded";
  occurredAt: string;
  marketId?: string;
  payload: T;
}

export interface BotCredentials {
  userId: string;
  accessToken: string;
  refreshToken?: string;
}

export interface XPost {
  id: string;
  text: string;
  authorId: string;
  authorHandle?: string;
  createdAt: string;
  conversationId?: string;
  repliedToPostId?: string;
}
