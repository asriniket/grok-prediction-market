import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { Market } from "../domain/types.js";

const summarySchema = z.object({
  summary: z.string().trim().min(40).max(420),
});

export interface MarketSummaryGenerator {
  generate(market: Market): Promise<string>;
}

export class UnavailableMarketSummaryGenerator implements MarketSummaryGenerator {
  async generate(): Promise<string> {
    throw new AppError("Market briefs need XAI_API_KEY", 503, "SUMMARY_UNAVAILABLE");
  }
}

/** Produces a concise, neutral brief from the material already attached to a market. */
export class GrokMarketSummaryGenerator implements MarketSummaryGenerator {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async generate(market: Market): Promise<string> {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string", minLength: 40, maxLength: 420 },
      },
    };
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "market_brief", strict: true, schema } },
        messages: [
          {
            role: "system",
            content: [
              "Write a neutral, plain-language market brief in two or three short sentences.",
              "Use only the supplied source post, market question, close date, and resolution criteria.",
              "Explain what the YES outcome means and the evidence or event that resolves it.",
              "Do not forecast, recommend a trade, state odds, imply certainty, add facts, or mention that you are an AI.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              `Source post: ${market.sourcePost.text}`,
              `Market question: ${market.question}`,
              `Market closes: ${market.closesAt}`,
              `Resolution criteria: ${market.resolutionCriteria.join(" ")}`,
            ].join("\n"),
          },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new AppError(`Grok market brief failed (${response.status}): ${body.slice(0, 240)}`, 502, "SUMMARY_XAI_ERROR");
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AppError("Grok did not return a market brief", 502, "SUMMARY_XAI_INVALID_RESPONSE");
    try {
      return summarySchema.parse(JSON.parse(content)).summary;
    } catch {
      throw new AppError("Grok returned an invalid market brief", 502, "SUMMARY_XAI_INVALID_RESPONSE");
    }
  }
}
