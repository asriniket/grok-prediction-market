import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { ClaimDraft, SourcePost } from "../domain/types.js";

const claimSchema = z.object({
  question: z.string().min(12).max(240),
  resolutionCriteria: z.array(z.string().min(8).max(500)).min(1).max(5),
  closesAt: z.string().datetime(),
  rationale: z.string().min(1).max(500),
});

export interface ClaimExtractor {
  extract(sourcePost: SourcePost): Promise<ClaimDraft>;
}

export class UnavailableClaimExtractor implements ClaimExtractor {
  async extract(): Promise<ClaimDraft> {
    throw new AppError(
      "Claim extraction needs XAI_API_KEY, or provide question, resolutionCriteria, and closesAt explicitly",
      503,
      "EXTRACTION_UNAVAILABLE",
    );
  }
}

/** Uses xAI structured output so the service never parses free-form model text. */
export class GrokClaimExtractor implements ClaimExtractor {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async extract(sourcePost: SourcePost): Promise<ClaimDraft> {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["question", "resolutionCriteria", "closesAt", "rationale"],
      properties: {
        question: { type: "string", minLength: 12, maxLength: 240 },
        resolutionCriteria: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", minLength: 8, maxLength: 500 } },
        closesAt: { type: "string", format: "date-time" },
        rationale: { type: "string", minLength: 1, maxLength: 500 },
      },
    };
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "market_claim", strict: true, schema } },
        messages: [
          {
            role: "system",
            content: [
              "Turn one social-media post into one binary prediction-market question.",
              "Accept only a falsifiable claim with an objectively checkable date and source-based resolution criteria.",
              "Question must begin with Will, Did, Is, Are, Does, or Has; it must end with a question mark.",
              "Set closesAt to the earliest defensible deadline in the claim; do not invent one.",
              "If the post lacks an unambiguous claim, still return JSON but make rationale explain why it is ambiguous and set question to 'Is this claim objectively resolvable?' so server validation rejects it.",
              "Do not treat popularity, likes, or a creator's intent as truth.",
            ].join(" "),
          },
          { role: "user", content: `Source post URL: ${sourcePost.url}\nAuthor: @${sourcePost.authorHandle}\nText:\n${sourcePost.text}` },
        ],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new AppError(`Grok extraction failed (${response.status}): ${body.slice(0, 240)}`, 502, "XAI_ERROR");
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new AppError("Grok did not return a structured claim", 502, "XAI_INVALID_RESPONSE");
    try {
      return claimSchema.parse(JSON.parse(content));
    } catch {
      throw new AppError("Grok returned an invalid market claim", 502, "XAI_INVALID_RESPONSE");
    }
  }
}

export function validateClaimDraft(draft: ClaimDraft, now = new Date()): ClaimDraft {
  const parsed = claimSchema.parse(draft);
  const question = parsed.question.trim();
  if (!/^(will|did|is|are|does|has)\b/i.test(question) || !question.endsWith("?")) {
    throw new AppError("The claim is not a valid binary, resolvable market question", 422, "UNRESOLVABLE_CLAIM");
  }
  const closesAt = new Date(parsed.closesAt);
  if (Number.isNaN(closesAt.valueOf()) || closesAt <= now || closesAt > new Date(now.valueOf() + 366 * 24 * 60 * 60 * 1000)) {
    throw new AppError("Market close must be between now and one year from now", 422, "INVALID_CLOSE_DATE");
  }
  const criteria = parsed.resolutionCriteria.map((criterion) => criterion.trim()).filter(Boolean);
  if (criteria.length === 0) throw new AppError("A market needs resolution criteria", 422, "UNRESOLVABLE_CLAIM");
  return { ...parsed, question, resolutionCriteria: criteria, closesAt: closesAt.toISOString() };
}
