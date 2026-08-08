import { AppError } from "../domain/errors.js";
import type { AccountHistoryInput, XPost } from "../domain/types.js";

const X_API_ORIGIN = "https://api.x.com/2";

interface XUser {
  id: string;
  username: string;
  created_at?: string;
  public_metrics?: { tweet_count?: number };
}

interface RawPost {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  public_metrics?: { impression_count?: number };
}

interface XResponse {
  data?: RawPost | RawPost[] | XUser;
  includes?: { users?: XUser[]; tweets?: RawPost[] };
  meta?: { newest_id?: string };
}

export class XApiClient {
  constructor(private readonly accessToken: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${X_API_ORIGIN}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new AppError(`X API request failed (${response.status}): ${text.slice(0, 280)}`, 502, "X_API_ERROR");
    }
    return response.json() as Promise<T>;
  }

  async getMentions(userId: string): Promise<XPost[]> {
    const query = new URLSearchParams({
      max_results: "100",
      "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets",
      expansions: "author_id,referenced_tweets.id",
      "user.fields": "username",
    });
    const response = await this.request<XResponse>(`/users/${encodeURIComponent(userId)}/mentions?${query}`);
    const users = new Map((response.includes?.users ?? []).map((user) => [user.id, user.username]));
    const posts = Array.isArray(response.data) ? response.data : [];
    return posts.map((post) => this.toPost(post, users));
  }

  async getPost(postId: string): Promise<XPost> {
    const query = new URLSearchParams({
      "tweet.fields": "created_at,author_id,conversation_id,referenced_tweets",
      expansions: "author_id",
      "user.fields": "username",
    });
    const response = await this.request<XResponse>(`/tweets/${encodeURIComponent(postId)}?${query}`);
    const post = response.data;
    if (!post || Array.isArray(post) || !("author_id" in post)) throw new AppError("X did not return the requested post", 404, "X_POST_NOT_FOUND");
    const users = new Map((response.includes?.users ?? []).map((user) => [user.id, user.username]));
    return this.toPost(post, users);
  }

  async getAccountHistory(userId: string): Promise<AccountHistoryInput> {
    const profile = await this.request<XResponse>(`/users/${encodeURIComponent(userId)}?user.fields=created_at,public_metrics,username`);
    const user = profile.data;
    if (!user || Array.isArray(user) || !("username" in user) || !user.created_at) {
      throw new AppError("X did not return the account history needed for karma", 422, "X_PROFILE_INCOMPLETE");
    }
    const query = new URLSearchParams({ max_results: "100", "tweet.fields": "public_metrics" });
    const timeline = await this.request<XResponse>(`/users/${encodeURIComponent(userId)}/tweets?${query}`);
    const posts = Array.isArray(timeline.data) ? timeline.data : [];
    const impressionSamples = posts
      .map((post) => post.public_metrics?.impression_count)
      .filter((count): count is number => typeof count === "number" && Number.isFinite(count) && count >= 0);
    return {
      xUserId: user.id,
      handle: user.username,
      accountCreatedAt: user.created_at,
      postCount: user.public_metrics?.tweet_count ?? 0,
      impressionSamples,
    };
  }

  async postReply(replyToPostId: string, text: string): Promise<string> {
    const response = await this.request<{ data?: { id?: string } }>("/tweets", {
      method: "POST",
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: replyToPostId } }),
    });
    const id = response.data?.id;
    if (!id) throw new AppError("X did not return a reply id", 502, "X_POST_FAILED");
    return id;
  }

  async getCurrentUser(): Promise<{ id: string; username: string }> {
    const response = await this.request<XResponse>("/users/me?user.fields=username");
    const user = response.data;
    if (!user || Array.isArray(user) || !("username" in user)) throw new AppError("X did not return the authorized bot account", 502, "X_AUTH_FAILED");
    return { id: user.id, username: user.username };
  }

  private toPost(post: RawPost, handles: Map<string, string>): XPost {
    return {
      id: post.id,
      text: post.text,
      authorId: post.author_id,
      authorHandle: handles.get(post.author_id),
      createdAt: post.created_at,
      conversationId: post.conversation_id,
      repliedToPostId: post.referenced_tweets?.find((reference) => reference.type === "replied_to")?.id,
    };
  }
}
