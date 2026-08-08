import { AppError } from "../domain/errors.js";
import { outcomePrice } from "../domain/lmsr.js";
import type { SourcePost, XPost } from "../domain/types.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { XApiClient } from "../integrations/x-client.js";
import { BotRegistry } from "../integrations/x-oauth.js";
import { MarketService } from "./market-service.js";

const COMMAND = /\bmarket\s+this\b/i;

function postIdInUrl(text: string): string | null {
  return text.match(/(?:x|twitter)\.com\/[\w_]+\/status\/(\d+)/i)?.[1] ?? null;
}

/** X adds the parent author mention to reply text; adding it ourselves creates duplicates. */
function replyText(message: string): string {
  return message.slice(0, 280);
}

export class XBotService {
  constructor(
    private readonly store: SqliteStore,
    private readonly bots: BotRegistry,
    private readonly markets: MarketService,
    private readonly appUrl: string,
  ) {}

  async poll(): Promise<{ configured: boolean; processed: number; replies: number; failures: number }> {
    const bot = this.bots.get();
    if (!bot) return { configured: false, processed: 0, replies: 0, failures: 0 };
    const client = new XApiClient(bot.accessToken);
    const mentions = await client.getMentions(bot.userId);
    const chronological = mentions.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    let processed = 0;
    let replies = 0;
    let failures = 0;
    for (const mention of chronological) {
      if (this.store.isMentionProcessed(mention.id)) continue;
      if (!COMMAND.test(mention.text)) {
        this.store.markMentionProcessed(mention.id);
        processed += 1;
        continue;
      }
      try {
        const replyId = await this.openMarketFromMention(client, mention);
        this.store.markMentionProcessed(mention.id, replyId);
        processed += 1;
        replies += 1;
      } catch (error) {
        failures += 1;
        // A bad/ambiguous post should get one useful response, but do not leak
        // API diagnostics or credentials to X.
        const message = error instanceof AppError && error.code === "EXTRACTION_UNAVAILABLE"
          ? "I need the claim extractor configured before I can open a market."
          : "I couldn't turn that into an objectively resolvable market. Reply to a time-bound, falsifiable claim and try again.";
        try {
          const replyId = await client.postReply(mention.id, replyText(message));
          this.store.markMentionProcessed(mention.id, replyId);
          processed += 1;
          replies += 1;
        } catch {
          // Do not mark it processed: a scheduler retry can recover a failed reply.
        }
      }
    }
    return { configured: true, processed, replies, failures };
  }

  private async openMarketFromMention(client: XApiClient, mention: XPost): Promise<string> {
    const sourceId = mention.repliedToPostId ?? postIdInUrl(mention.text);
    if (!sourceId) {
      return client.postReply(
        mention.id,
        replyText("Reply directly to the post you want to market, then mention me with ‘market this’."),
      );
    }
    const post = await client.getPost(sourceId);
    const history = await client.getAccountHistory(post.authorId);
    this.markets.createAccount(history);
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
    const action = created ? "Market opened" : "That market already exists";
    return client.postReply(
      mention.id,
      replyText(`${action} · YES ${yesPrice}¢ / NO ${100 - yesPrice}¢\n${this.appUrl}/markets/${market.id}`),
    );
  }
}
