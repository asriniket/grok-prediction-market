import { z } from "zod";
import { AppError } from "../domain/errors.js";
import type { Market, MarketAnalysis } from "../domain/types.js";

const pulseSchema = z.object({
  body: z.string().trim().min(140).max(1_500),
  posts: z.array(z.object({
    url: z.string().url(),
    handle: z.string().trim().min(1).max(50),
    text: z.string().trim().min(8).max(500),
    createdAt: z.string().trim().min(4).max(80),
    relevance: z.string().trim().min(8).max(180),
  }).strict()).min(3).max(7),
}).strict();

interface ResponsesReply {
  output_text?: string;
  citations?: string[];
  output?: Array<Record<string, unknown>>;
}

export interface MarketAnalysisGenerator {
  generate(market: Market): Promise<MarketAnalysis>;
}

export class UnavailableMarketAnalysisGenerator implements MarketAnalysisGenerator {
  async generate(): Promise<MarketAnalysis> {
    throw new AppError("Market AI analysis needs XAI_API_KEY", 503, "ANALYSIS_UNAVAILABLE");
  }
}

function extractFunctionArguments(reply: ResponsesReply, name: string): unknown {
  let result: unknown;
  const walk = (value: unknown): void => {
    if (result !== undefined) return;
    if (Array.isArray(value)) return void value.forEach(walk);
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "function_call" && node.name === name) {
      const args = node.arguments;
      result = typeof args === "string" ? JSON.parse(args) : args;
      return;
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(reply.output);
  return result;
}

function extractCitations(reply: ResponsesReply): string[] {
  const citations = new Set<string>();
  const addUrl = (value: unknown): void => {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") citations.add(url.toString());
    } catch {
      // xAI response payloads contain other strings beside URLs.
    }
  };
  for (const citation of reply.citations ?? []) addUrl(citation);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "url" || key === "citation") addUrl(child);
      else walk(child);
    }
  };
  walk(reply.output);
  return [...citations].slice(0, 8);
}

function statusId(url: string): string | null {
  return url.match(/(?:x|twitter)\.com\/(?:i\/)?(?:[\w_]+\/)?status\/(\d+)/i)?.[1] ?? null;
}

/**
 * A cached, contextual X pulse. It is deliberately distinct from resolution:
 * it summarizes current conversation signals and names what remains uncertain.
 */
export class GrokMarketAnalysisGenerator implements MarketAnalysisGenerator {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async generate(market: Market): Promise<MarketAnalysis> {
    const fromDate = new Date(Math.max(0, Date.now() - 180 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    const response = await fetch("https://api.x.ai/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "system",
            content: [
              "You write Threadline's Market AI analysis after searching X.",
              "You must use the X Search tool before writing.",
              "This is a pulse of observed conversation, not a prediction, trade recommendation, or resolution decision.",
              "Do not state or imply that popularity, a post, engagement, or a rumor proves the outcome.",
              "Use only signals you actually found in X Search and the supplied source post. If signal is weak, say so explicitly.",
              "First use X Search, then call report_market_pulse with the requested structured result.",
              "The body must contain exactly these four labeled sections in plain text: Pulse, Catalysts, Counter-signals, and Watch.",
              "Pulse must synthesize the current and historical X context in two concise sentences. Catalysts and Counter-signals must each identify up to two concrete observed items. Watch must name the next public fact that would change the discussion. Keep the body under 1,500 characters.",
              "Do not put URLs, @handles, markdown links, parenthetical citations, or a source list in the body. The interface renders the exact searched posts separately as sources below the analysis.",
            ].join(" "),
          },
          {
            role: "user",
            content: [
              `Source post by @${market.sourcePost.authorHandle} at ${market.sourcePost.createdAt}: ${market.sourcePost.text}`,
              `Market question: ${market.question}`,
              `Market closes: ${market.closesAt}`,
              `Resolution criteria: ${market.resolutionCriteria.join(" ")}`,
              "Search for relevant past and current X posts before writing the analysis. Return 5-7 distinct searched posts spanning both current discussion and useful historical context whenever that evidence exists.",
            ].join("\n"),
          },
        ],
        tools: [
          { type: "x_search", from_date: fromDate },
          {
            type: "function",
            name: "report_market_pulse",
            description: "Return the synthesized X pulse and 3-7 exact, distinct X posts found during the search.",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["body", "posts"],
              properties: {
                body: { type: "string", minLength: 140, maxLength: 1500 },
                posts: {
                  type: "array",
                  minItems: 3,
                  maxItems: 7,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["url", "handle", "text", "createdAt", "relevance"],
                    properties: {
                      url: { type: "string" },
                      handle: { type: "string", minLength: 1, maxLength: 50 },
                      text: { type: "string", minLength: 8, maxLength: 500 },
                      createdAt: { type: "string", minLength: 4, maxLength: 80 },
                      relevance: { type: "string", minLength: 8, maxLength: 180 },
                    },
                  },
                },
              },
            },
          },
        ],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_output_tokens: 900,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new AppError(`Grok X pulse failed (${response.status}): ${body.slice(0, 240)}`, 502, "ANALYSIS_XAI_ERROR");
    }
    const reply = await response.json() as ResponsesReply;
    try {
      const result = pulseSchema.parse(extractFunctionArguments(reply, "report_market_pulse"));
      const citations = extractCitations(reply);
      const citedStatusIds = new Set(citations.map(statusId).filter((id): id is string => id !== null));
      const searchedPosts = result.posts.filter((post) => {
        const id = statusId(post.url);
        return citedStatusIds.size === 0 || (id !== null && citedStatusIds.has(id));
      });
      const sourcePost = {
        url: market.sourcePost.url,
        handle: market.sourcePost.authorHandle,
        text: market.sourcePost.text,
        createdAt: market.sourcePost.createdAt,
        relevance: "The post that opened this market.",
      };
      const posts = [sourcePost, ...searchedPosts].filter((post, index, all) =>
        all.findIndex((candidate) => candidate.url === post.url) === index,
      ).slice(0, 8);
      if (posts.length < 4) throw new Error("Too few source-verified posts");
      return {
        body: result.body,
        sources: extractCitations(reply),
        posts,
        generatedAt: new Date().toISOString(),
      };
    } catch {
      throw new AppError("Grok returned an invalid Market AI analysis", 502, "ANALYSIS_XAI_INVALID_RESPONSE");
    }
  }
}
