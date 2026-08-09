import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp, type AppDependencies } from "../src/app.js";
import { crcResponseToken, hasValidWebhookSignature, xActivityMentions } from "../src/services/x-webhook.js";

describe("X webhook helpers", () => {
  it("creates the documented CRC token and verifies only the exact signed bytes", () => {
    const secret = "consumer-secret";
    const crcToken = "challenge";
    expect(crcResponseToken(secret, crcToken)).toMatch(/^sha256=/);
    const rawBody = Buffer.from('{"for_user_id":"1"}');
    const signature = crcResponseToken(secret, rawBody.toString("utf8"));
    expect(hasValidWebhookSignature(secret, rawBody, signature)).toBe(true);
    expect(hasValidWebhookSignature(secret, Buffer.from('{"for_user_id":"2"}'), signature)).toBe(false);
  });

  it("normalizes current X Activity post.mention.create events", () => {
    const payload = {
      data: {
        event_uuid: "event-1",
        event_type: "post.mention.create",
        filter: { user_id: "2086271258564739072" },
        payload: {
          id: "2087000000000000004",
          text: "@ThreadlineBot market this",
          author_id: "333",
          created_at: "2026-08-09T04:00:00.000Z",
          conversation_id: "2086000000000000003",
          referenced_tweets: [{ type: "replied_to", id: "2086000000000000003" }],
        },
        includes: { users: [{ id: "333", username: "maker" }] },
      },
    };
    expect(xActivityMentions(payload, "2086271258564739072")).toEqual([
      expect.objectContaining({
        id: "2087000000000000004",
        authorId: "333",
        authorHandle: "maker",
        repliedToPostId: "2086000000000000003",
      }),
    ]);
    expect(xActivityMentions({ data: { ...payload.data, filter: { user_id: "999" } } }, "2086271258564739072")).toEqual([]);
    expect(xActivityMentions({ for_user_id: "2086271258564739072", tweet_create_events: [] }, "2086271258564739072")).toEqual([]);
  });
});

describe("X Account Activity webhook endpoint", () => {
  it("serves CRC and only accepts an event with a valid raw-body signature", async () => {
    const secret = "consumer-secret";
    const acceptWebhookEvents = vi.fn().mockReturnValue({ configured: true, accepted: 1 });
    const app = createApp({
      xConsumerSecret: secret,
      xBots: { acceptWebhookEvents },
    } as unknown as AppDependencies);
    const server = app.listen(0);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const crc = await fetch(`${baseUrl}/webhooks/x?crc_token=challenge`);
      expect(crc.status).toBe(200);
      await expect(crc.json()).resolves.toEqual({ response_token: crcResponseToken(secret, "challenge") });

      const payload = JSON.stringify({ for_user_id: "2086271258564739072", tweet_create_events: [] });
      const event = await fetch(`${baseUrl}/webhooks/x`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-twitter-webhooks-signature": crcResponseToken(secret, payload),
        },
        body: payload,
      });
      expect(event.status).toBe(202);
      await expect(event.json()).resolves.toEqual({ configured: true, accepted: 1 });
      expect(acceptWebhookEvents).toHaveBeenCalledWith(JSON.parse(payload));

      const rejected = await fetch(`${baseUrl}/webhooks/x`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      expect(rejected.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
