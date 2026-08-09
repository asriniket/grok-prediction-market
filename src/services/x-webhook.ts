import { createHmac, timingSafeEqual } from "node:crypto";
import type { XPost } from "../domain/types.js";

type RawObject = Record<string, unknown>;

function object(value: unknown): RawObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RawObject : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function id(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

/** Builds X's CRC response using the app Consumer/API Secret, never a user token. */
export function crcResponseToken(consumerSecret: string, crcToken: string): string {
  return `sha256=${createHmac("sha256", consumerSecret).update(crcToken).digest("base64")}`;
}

/** Verifies the signature against the exact, unparsed bytes X delivered. */
export function hasValidWebhookSignature(consumerSecret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", consumerSecret).update(rawBody).digest("base64")}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function expandedXUrls(tweet: RawObject): string[] {
  const entities = object(tweet.extended_tweet)?.entities ?? tweet.entities;
  const urls = object(entities)?.urls;
  if (!Array.isArray(urls)) return [];
  return urls.flatMap((entry) => {
    const url = object(entry);
    const expanded = text(url?.expanded_url);
    return expanded && /(?:x|twitter)\.com\/[^/]+\/status\/\d+/i.test(expanded) ? [expanded] : [];
  });
}

/**
 * Account Activity sends a legacy Tweet-shaped payload. Normalize only the
 * fields the existing bot flow needs, and ignore bot-authored or unrelated
 * activity before any reply can be posted.
 */
export function accountActivityMentions(payload: unknown, botUserId: string): XPost[] {
  const root = object(payload);
  if (!root || id(root.for_user_id) !== botUserId || !Array.isArray(root.tweet_create_events)) return [];
  return root.tweet_create_events.flatMap((entry) => {
    const tweet = object(entry);
    if (!tweet) return [];
    const user = object(tweet.user);
    const authorId = id(tweet.author_id) ?? id(tweet.user_id_str) ?? id(user?.id_str) ?? id(user?.id);
    const postId = id(tweet.id_str) ?? id(tweet.id);
    const fullText = text(object(tweet.extended_tweet)?.full_text) ?? text(tweet.text);
    if (!postId || !authorId || !fullText || authorId === botUserId) return [];
    const sourceLinks = expandedXUrls(tweet);
    return [{
      id: postId,
      text: [fullText, ...sourceLinks].join("\n"),
      authorId,
      authorHandle: text(user?.screen_name),
      createdAt: text(tweet.created_at) ?? new Date().toISOString(),
      conversationId: id(tweet.conversation_id_str) ?? id(tweet.conversation_id),
      repliedToPostId: id(tweet.in_reply_to_status_id_str) ?? id(tweet.in_reply_to_status_id),
    }];
  });
}
