import { config, requireXaiKey } from '../config.js';

export class XaiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`xAI ${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = 'XaiHttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Responses API intermittently returns 500 "Internal error during token
 * parsing", especially on search calls — observed hitting unrelated handles on
 * the same request shape, so it is transient rather than input-specific.
 * Retried with backoff; 429 is retried too.
 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function request<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
  const url = `${config.apiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${requireXaiKey()}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    if (isRetryable(res.status) && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      return request<T>(path, init, attempt + 1);
    }
    throw new XaiHttpError(res.status, text, path);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export const xai = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};

// ---------- Responses API ----------

export type XSearchTool = {
  type: 'x_search';
  allowed_x_handles?: string[];
  excluded_x_handles?: string[];
  from_date?: string;
  to_date?: string;
  enable_image_understanding?: boolean;
  enable_video_understanding?: boolean;
};

export type WebSearchTool = { type: 'web_search'; allowed_domains?: string[]; excluded_domains?: string[] };

export type FunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

export type ResponsesRequest = {
  model: string;
  input: unknown;
  tools?: Array<XSearchTool | WebSearchTool | FunctionTool>;
  tool_choice?: unknown;
  max_output_tokens?: number;
  text?: Record<string, unknown>;
};

export type ResponsesReply = {
  id?: string;
  model?: string;
  status?: string;
  output?: Array<Record<string, any>>;
  output_text?: string;
  citations?: string[];
  usage?: Record<string, any>;
  [k: string]: unknown;
};

export function createResponse(body: ResponsesRequest): Promise<ResponsesReply> {
  return xai.post<ResponsesReply>('/responses', body);
}

/**
 * The Responses API returns a heterogeneous `output` array. Pull out the plain
 * assistant text regardless of whether the SDK-style `output_text` shortcut is
 * present.
 */
export function extractText(reply: ResponsesReply): string {
  if (typeof reply.output_text === 'string' && reply.output_text) return reply.output_text;
  const chunks: string[] = [];
  for (const item of reply.output ?? []) {
    if (item?.type === 'message') {
      for (const c of item.content ?? []) {
        if (typeof c?.text === 'string') chunks.push(c.text);
      }
    }
  }
  return chunks.join('\n').trim();
}

/** Collect X/web citations from wherever the API surfaced them. */
export function extractCitations(reply: ResponsesReply): string[] {
  const found = new Set<string>();
  for (const c of reply.citations ?? []) if (typeof c === 'string') found.add(c);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === 'url' || k === 'citation') && typeof v === 'string') found.add(v);
      else walk(v);
    }
  };
  walk(reply.output);
  return [...found];
}

/** Pull any function calls the model asked us to run. */
export function extractFunctionCalls(reply: ResponsesReply): Array<{ name: string; arguments: string }> {
  const calls: Array<{ name: string; arguments: string }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, any>;
    if (o.type === 'function_call' && typeof o.name === 'string') {
      calls.push({ name: o.name, arguments: typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments ?? {}) });
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(reply.output);
  return calls;
}
