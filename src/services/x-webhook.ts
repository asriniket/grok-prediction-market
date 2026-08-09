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

function activityAuthorHandle(event: RawObject, authorId: string): string | undefined {
  const users = object(event.includes)?.users;
  if (!Array.isArray(users)) return undefined;
  for (const entry of users) {
    const user = object(entry);
    if (id(user?.id) === authorId) return text(user?.username);
  }
  return undefined;
}

function activityMention(payload: RawObject, botUserId: string): XPost[] {
  const event = object(payload.data);
  if (!event || text(event.event_type) !== "post.mention.create") return [];
  if (id(object(event.filter)?.user_id) !== botUserId) return [];
  const post = object(event.payload);
  if (!post) return [];
  const postId = id(post.id);
  const authorId = id(post.author_id);
  const postText = text(post.text);
  if (!postId || !authorId || !postText || authorId === botUserId) return [];
  const references = Array.isArray(post.referenced_tweets) ? post.referenced_tweets : [];
  const repliedToPostId = references
    .map(object)
    .find((reference) => text(reference?.type) === "replied_to")
    ?.id;
  const sourceLinks = expandedXUrls(post);
  return [{
    id: postId,
    text: [postText, ...sourceLinks].join("\n"),
    authorId,
    authorHandle: activityAuthorHandle(event, authorId),
    createdAt: text(post.created_at) ?? new Date().toISOString(),
    conversationId: id(post.conversation_id),
    repliedToPostId: id(repliedToPostId),
  }];
}

function legacyAccountActivityMentions(payload: RawObject, botUserId: string): XPost[] {
  if (id(payload.for_user_id) !== botUserId || !Array.isArray(payload.tweet_create_events)) return [];
  return payload.tweet_create_events.flatMap((entry) => {
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

/**
 * X Activity is the current real-time API. Normalize its post.mention.create
 * event into the bot's existing XPost shape. The legacy Account Activity
 * format remains accepted while X completes that product's deprecation.
 */
export function xWebhookMentions(payload: unknown, botUserId: string): XPost[] {
  const root = object(payload);
  if (!root) return [];
  const currentActivityMentions = activityMention(root, botUserId);
  return currentActivityMentions.length > 0
    ? currentActivityMentions
    : legacyAccountActivityMentions(root, botUserId);
}
