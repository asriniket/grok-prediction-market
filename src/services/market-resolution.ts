import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { Market, Outcome } from "../domain/types.js";

export type ResolutionOutcome = Outcome | "UNRESOLVABLE" | "PENDING";

export interface MarketResolution {
  outcome: ResolutionOutcome;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  sources: string[];
}

export interface MarketResolver {
  resolve(market: Market): Promise<MarketResolution>;
}

const decisionSchema = z.object({
  outcome: z.enum(["YES", "NO", "UNRESOLVABLE", "PENDING"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  reason: z.string().trim().min(20).max(900),
  sources: z.array(z.string().url()).max(5),
}).strict();

interface ResponsesReply {
  id?: string;
  citations?: string[];
  output?: Array<Record<string, unknown>>;
}

function extractFunctionArguments(reply: ResponsesReply, name: string): unknown {
  let result: unknown;
  const walk = (value: unknown): void => {
    if (result !== undefined) return;
    if (Array.isArray(value)) return void value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "function_call" && node.name === name) {
      result = typeof node.arguments === "string" ? JSON.parse(node.arguments) : node.arguments;
      return;
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(reply.output);
  return result;
}

function normalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function extractCitations(reply: ResponsesReply): string[] {
  const citations = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const url = normalUrl(value);
    if (url) citations.add(url);
  };
  for (const citation of reply.citations ?? []) add(citation);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "url" || key === "citation") add(child);
      else walk(child);
    }
  };
  walk(reply.output);
  return [...citations];
}

export class UnavailableMarketResolver implements MarketResolver {
  async resolve(): Promise<MarketResolution> {
    throw new AppError("Grok market resolution needs XAI_API_KEY", 503, "RESOLUTION_UNAVAILABLE");
  }
}

/**
 * Grok researches a due market, then returns a constrained settlement proposal.
 * It can never move money itself: MarketService verifies the verdict and the
 * store performs the idempotent ledger settlement in one transaction.
 */
export class GrokMarketResolver implements MarketResolver {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async resolve(market: Market): Promise<MarketResolution> {
    const webResearch = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "system",
            content: [
              "Research an already-closed Threadline prediction market for potential settlement.",
              "Search the web for primary or authoritative sources when they exist; never treat popularity, rumors, or an unsourced post as proof.",
              "Read the exact resolution criteria. Collect only evidence that can distinguish YES, NO, or a genuinely unresolvable market.",
              "Do not make a settlement decision yet. This research will be reviewed in a second structured step.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              `Market question: ${market.question}`,
              `Market close: ${market.closesAt}`,
              `Resolution criteria: ${market.resolutionCriteria.join(" ")}`,
              `Source post: ${market.sourcePost.text}`,
            ].join("\n"),
          },
        ],
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_output_tokens: 1_200,
      }),
    });
    if (!webResearch.ok) {
      const body = await webResearch.text();
      throw new AppError(`Grok web research failed (${webResearch.status}): ${body.slice(0, 240)}`, 502, "RESOLUTION_XAI_ERROR");
    }
    const webReply = await webResearch.json() as ResponsesReply;
    if (!webReply.id) throw new AppError("Grok did not return a web-research session", 502, "RESOLUTION_XAI_INVALID_RESPONSE");

    // A separate forced X pass is intentional: tool_choice: required only
    // guarantees one tool use, not both kinds of evidence in one turn.
    const xResearch = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        previous_response_id: webReply.id,
        input: [{
          role: "user",
          content: [
            "Now search X for direct, time-relevant evidence or authoritative account announcements about this market.",
            "Do not decide the market yet. Preserve the web evidence and collect only material that can support or contradict the exact resolution criteria.",
          ].join(" "),
        }],
        tools: [{ type: "x_search", from_date: market.createdAt.slice(0, 10) }],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_output_tokens: 1_200,
      }),
    });
    if (!xResearch.ok) {
      const body = await xResearch.text();
      throw new AppError(`Grok X research failed (${xResearch.status}): ${body.slice(0, 240)}`, 502, "RESOLUTION_XAI_ERROR");
    }
    const xReply = await xResearch.json() as ResponsesReply;
    if (!xReply.id) throw new AppError("Grok did not return an X-research session", 502, "RESOLUTION_XAI_INVALID_RESPONSE");

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "confidence", "reason", "sources"],
      properties: {
        outcome: { type: "string", enum: ["YES", "NO", "UNRESOLVABLE", "PENDING"] },
        confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
        reason: { type: "string", minLength: 20, maxLength: 900 },
        sources: { type: "array", minItems: 0, maxItems: 5, items: { type: "string" } },
      },
    };
    const decision = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        previous_response_id: xReply.id,
        input: [{
          role: "user",
          content: [
            "Using the researched sources, report a settlement proposal now.",
            "Return YES or NO only when the evidence directly satisfies the stated resolution criteria and your confidence is HIGH.",
            "Return PENDING for incomplete, conflicting, weak, or unverified evidence. Return UNRESOLVABLE only when the criteria cannot be fairly applied after the deadline.",
            "For any non-PENDING result, sources must be exact URLs from the research citations. Do not invent or restate URLs.",
            "Call report_market_resolution exactly once.",
          ].join(" "),
        }],
        tools: [{
          type: "function",
          name: "report_market_resolution",
          description: "Return a settlement proposal based only on the completed research.",
          parameters: schema,
        }],
        tool_choice: { type: "function", function: { name: "report_market_resolution" } },
        parallel_tool_calls: false,
      }),
    });
    if (!decision.ok) {
      const body = await decision.text();
      throw new AppError(`Grok resolution decision failed (${decision.status}): ${body.slice(0, 240)}`, 502, "RESOLUTION_XAI_ERROR");
    }

    const decisionReply = await decision.json() as ResponsesReply;
    try {
      const candidate = decisionSchema.parse(extractFunctionArguments(decisionReply, "report_market_resolution"));
      const citations = new Set([...extractCitations(webReply), ...extractCitations(xReply), ...extractCitations(decisionReply)]);
      const sources = [...new Set(candidate.sources.map(normalUrl).filter((url): url is string => url !== null))]
        .filter((url) => citations.has(url));
      if (candidate.outcome !== "PENDING" && (candidate.confidence !== "HIGH" || sources.length === 0)) {
        return {
          outcome: "PENDING",
          confidence: candidate.confidence,
          reason: "The research did not produce enough source-verified, high-confidence evidence to settle this market automatically.",
          sources,
        };
      }
      return { ...candidate, sources };
    } catch {
      throw new AppError("Grok returned an invalid market resolution", 502, "RESOLUTION_XAI_INVALID_RESPONSE");
    }
  }
}
