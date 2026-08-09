import { AppError } from "../domain/errors.js";
import { outcomePrice } from "../domain/lmsr.js";
import type { BotCredentials, SourcePost, XPost } from "../domain/types.js";
import type { MarketStore } from "../infrastructure/store.js";
import { XApiClient } from "../integrations/x-client.js";
import { BotRegistry } from "../integrations/x-oauth.js";
import { MarketService } from "./market-service.js";
import { xActivityMentions } from "./x-webhook.js";

function postIdInUrl(text: string): string | null {
  return text.match(/(?:x|twitter)\.com\/[\w_]+\/status\/(\d+)/i)?.[1] ?? null;
}

/** X adds the parent author mention to reply text; adding it ourselves creates duplicates. */
function replyText(message: string): string {
  return message.slice(0, 280);
}

function marketReply(created: boolean, question: string, yesPrice: number, marketUrl: string): string {
  const header = created ? "MARKET OPEN" : "MARKET ALREADY OPEN";
  const odds = `YES ${yesPrice}¢  ·  NO ${100 - yesPrice}¢`;
  const destination = `View market → ${marketUrl}`;
  const available = Math.max(0, 280 - header.length - odds.length - destination.length - 3);
  const normalizedQuestion = question.replace(/\s+/g, " ").trim();
  const title = normalizedQuestion.length > available
    ? available > 1 ? `${normalizedQuestion.slice(0, available - 1).trimEnd()}…` : ""
    : normalizedQuestion;
  return [header, title, odds, destination].filter(Boolean).join("\n");
}

function isExpiredBotToken(error: unknown): boolean {
  return error instanceof AppError && error.code === "X_AUTH_EXPIRED";
}

function marketCreationFailureReply(error: unknown): string {
  if (!(error instanceof AppError)) return "I couldn't turn that into an objectively resolvable market. Try a concrete, time-bound claim.";
  if (error.code === "EXTRACTION_UNAVAILABLE") return "I need the market AI configured before I can open a market.";
  if (error.code === "XAI_ERROR" || error.code === "XAI_INVALID_RESPONSE") return "Market AI is temporarily unavailable. Try again shortly.";
  if (error.code === "INVALID_CLOSE_DATE") return "That market deadline is outside Threadline's supported range. Try a date within the next 10 years.";
  return "I couldn't turn that into an objectively resolvable market. Try a concrete, time-bound claim.";
}

export class XBotService {
  private readonly pendingMentionIds = new Set<string>();

  constructor(
    private readonly store: MarketStore,
    private readonly bots: BotRegistry,
    private readonly markets: MarketService,
    private readonly appUrl: string,
    private readonly refreshBot?: () => Promise<BotCredentials>,
  ) {}

  async poll(): Promise<{ configured: boolean; processed: number; replies: number; failures: number }> {
    const bot = this.bots.get();
    if (!bot) return { configured: false, processed: 0, replies: 0, failures: 0 };
    return this.withBotClient(async (activeBot, client) => {
      const mentions = await client.getMentions(activeBot.userId);
      const chronological = mentions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      let processed = 0;
      let replies = 0;
      let failures = 0;
      for (const mention of chronological) {
        const result = await this.processMention(mention, client);
        processed += result.processed ? 1 : 0;
        replies += result.replied ? 1 : 0;
        failures += result.failed ? 1 : 0;
      }
      return { configured: true, processed, replies, failures };
    });
  }

  /**
   * Accepts a signed X webhook payload and queues its mentions after returning
   * HTTP 202. X requires a fast acknowledgement; the potentially slower Grok
   * market-creation call must not keep the webhook request open.
   */
  acceptWebhookEvents(payload: unknown): { configured: boolean; accepted: number } {
    const bot = this.bots.get();
    if (!bot) return { configured: false, accepted: 0 };
    const mentions = xActivityMentions(payload, bot.userId);
    for (const mention of mentions) {
      queueMicrotask(() => {
        void this.withBotClient((_activeBot, client) => this.processMention(mention, client)).catch((error) => {
          console.error(`X webhook mention ${mention.id} failed`, error);
        });
      });
    }
    return { configured: true, accepted: mentions.length };
  }

  private async processMention(mention: XPost, client: XApiClient): Promise<{ processed: boolean; replied: boolean; failed: boolean }> {
    if (this.pendingMentionIds.has(mention.id)) return { processed: false, replied: false, failed: false };
    this.pendingMentionIds.add(mention.id);
    try {
      if (await this.store.isMentionProcessed(mention.id)) return { processed: false, replied: false, failed: false };
      try {
        const replyId = await this.openMarketFromMention(client, mention);
        await this.store.markMentionProcessed(mention.id, replyId);
        return { processed: true, replied: true, failed: false };
      } catch (error) {
        if (isExpiredBotToken(error)) throw error;
        // Reply with an actionable product error without leaking upstream API
        // diagnostics or credentials to X.
        const message = marketCreationFailureReply(error);
        try {
          const replyId = await client.postReply(mention.id, replyText(message));
          await this.store.markMentionProcessed(mention.id, replyId);
          return { processed: true, replied: true, failed: true };
        } catch (replyError) {
          if (isExpiredBotToken(replyError)) throw replyError;
          // Polling can retry this later; webhook failures are logged so X's
          // replay API can be used to redeliver a bounded missed window.
          return { processed: false, replied: false, failed: true };
        }
      }
    } finally {
      this.pendingMentionIds.delete(mention.id);
    }
  }

  private async withBotClient<T>(operation: (bot: BotCredentials, client: XApiClient) => Promise<T>): Promise<T> {
    const current = this.bots.get();
    if (!current) throw new AppError("The market bot is not authorized", 503, "BOT_REAUTH_REQUIRED");
    try {
      return await operation(current, new XApiClient(current.accessToken));
    } catch (error) {
      if (!isExpiredBotToken(error) || !this.refreshBot) throw error;
      const refreshed = await this.refreshBot();
      return operation(refreshed, new XApiClient(refreshed.accessToken));
    }
  }

  private async openMarketFromMention(client: XApiClient, mention: XPost): Promise<string> {
    // A reply markets its parent, a pasted post URL markets that post, and a
    // direct @ThreadlineBot mention markets the mention itself.
    const sourceId = mention.repliedToPostId ?? postIdInUrl(mention.text) ?? mention.id;
    const post = await client.getPost(sourceId);
    const history = await client.getAccountHistory(post.authorId);
    await this.markets.createAccount(history);
    const sourcePost: SourcePost = {
      id: post.id,
      url: `https://x.com/${post.authorHandle ?? history.handle}/status/${post.id}`,
      text: post.text,
      authorId: post.authorId,
      authorHandle: post.authorHandle ?? history.handle,
      createdAt: post.createdAt,
    };
    const { market, created } = await this.markets.createMarket({ sourcePost, creatorUserId: mention.authorId });
    const yesPrice = Math.round(outcomePrice({ liquidityB: market.liquidityB, yesShares: market.yesShares, noShares: market.noShares }, "YES") * 100);
    return client.postReply(mention.id, marketReply(created, market.question, yesPrice, `${this.appUrl}/markets/${market.id}`));
  }
}
