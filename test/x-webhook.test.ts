import { describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp, type AppDependencies } from "../src/app.js";
import { accountActivityMentions, crcResponseToken, hasValidWebhookSignature } from "../src/services/x-webhook.js";

describe("X Account Activity webhook helpers", () => {
  it("creates the documented CRC token and verifies only the exact signed bytes", () => {
    const secret = "consumer-secret";
    const crcToken = "challenge";
    expect(crcResponseToken(secret, crcToken)).toMatch(/^sha256=/);
    const rawBody = Buffer.from('{"for_user_id":"1"}');
    const signature = crcResponseToken(secret, rawBody.toString("utf8"));
    expect(hasValidWebhookSignature(secret, rawBody, signature)).toBe(true);
    expect(hasValidWebhookSignature(secret, Buffer.from('{"for_user_id":"2"}'), signature)).toBe(false);
  });

  it("normalizes mention events and ignores the subscribed bot's own posts", () => {
    const payload = {
      for_user_id: "2086271258564739072",
      tweet_create_events: [
        {
          id_str: "2087000000000000001",
          created_at: "Fri Aug 08 21:00:00 +0000 2026",
          text: "@ThreadlineBot market this",
          in_reply_to_status_id_str: "2086000000000000001",
          user: { id_str: "111", screen_name: "maker" },
        },
        {
          id_str: "2087000000000000002",
          text: "MARKET THIS https://t.co/example",
          user: { id_str: "222", screen_name: "linker" },
          extended_tweet: {
            full_text: "@ThreadlineBot market this https://t.co/example",
            entities: { urls: [{ expanded_url: "https://x.com/source/status/2086000000000000002" }] },
          },
        },
        {
          id_str: "2087000000000000003",
          text: "MARKET THIS",
          user: { id_str: "2086271258564739072", screen_name: "ThreadlineBot" },
        },
      ],
    };

    expect(accountActivityMentions(payload, "2086271258564739072")).toEqual([
      expect.objectContaining({ id: "2087000000000000001", authorId: "111", repliedToPostId: "2086000000000000001" }),
      expect.objectContaining({
        id: "2087000000000000002",
        authorId: "222",
        text: expect.stringContaining("https://x.com/source/status/2086000000000000002"),
      }),
    ]);
    expect(accountActivityMentions({ for_user_id: "999", tweet_create_events: payload.tweet_create_events }, "2086271258564739072")).toEqual([]);
  });
});

describe("X Account Activity webhook endpoint", () => {
  it("serves CRC and only accepts an event with a valid raw-body signature", async () => {
    const secret = "consumer-secret";
    const acceptAccountActivity = vi.fn().mockReturnValue({ configured: true, accepted: 1 });
    const app = createApp({
      xConsumerSecret: secret,
      xBots: { acceptAccountActivity },
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
      expect(acceptAccountActivity).toHaveBeenCalledWith(JSON.parse(payload));

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
