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
  /** User-facing, source-grounded market analysis generated with the claim. */
  summary?: string;
  resolutionCriteria: string[];
  closesAt: string;
  rationale: string;
}

export interface MarketAnalysis {
  /** A source-aware X pulse, never a market-resolution decision or trade recommendation. */
  body: string;
  sources: string[];
  posts: MarketPulsePost[];
  generatedAt: string;
}

export interface MarketPulsePost {
  url: string;
  handle: string;
  text: string;
  createdAt: string;
  relevance: string;
}

export interface Market {
  id: string;
  sourcePost: SourcePost;
  creatorUserId: string;
  question: string;
  /** Short source-grounded synopsis created together with the market. */
  summary: string | null;
  /** Cached X-search synthesis, generated when a market is first opened. */
  analysis: MarketAnalysis | null;
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
  side: "BUY" | "SELL";
  outcome: Outcome;
  credits: number;
  shares: number;
  priceAfter: number;
  executedAt: string;
  /** Replaying the same request key returns this trade without moving the book twice. */
  idempotencyKey?: string;
}

export interface MarketPricePoint {
  marketId: string;
  priceYes: number;
  recordedAt: string;
  kind: "OPEN" | "TRADE" | "DEMO";
}

export interface MarketMetrics {
  /** LMSR depth: higher values make a given trade move the price less. */
  liquidityDepth: number;
  /** Mean absolute price movement across the recent chart window. */
  volatility: number;
  activityCount: number;
  demoActivityCount: number;
}

export interface MarketSnapshot {
  market: Market;
  priceYes: number;
  priceNo: number;
  position: Position | null;
  metrics: MarketMetrics;
}

export interface PortfolioPosition {
  market: Market;
  position: Position;
  priceYes: number;
  priceNo: number;
  /** Credits returned by closing all remaining shares at the current AMM state. */
  estimatedExitValue: number;
  /** Mark-to-market result on the open position, excluding prior realized exits. */
  openPnl: number;
}

export interface Portfolio {
  account: Account;
  positions: PortfolioPosition[];
  estimatedExitValue: number;
  totalEquity: number;
}

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type:
    | "market.created"
    | "market.trade.executed"
    | "market.demo.pulse"
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
