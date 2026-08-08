import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { createResponse, extractFunctionCalls } from './xai/rest.js';

/**
 * Seeds the engine with real accounts, real markets, and enough trading for the
 * channel to have something to report.
 *
 *   npm run seed
 *
 * Accounts are seeded from metrics actually gathered from X — account tenure
 * and per-post impression samples — so the engine computes genuine karma rather
 * than being handed a number. Markets come from real claim-shaped posts.
 *
 * Trading is SYNTHETIC: each account is given a private belief per market and
 * trades toward it. The balances are real; the behaviour on top is simulated,
 * and the demo should say so.
 */

const ENGINE = config.engineUrl;
const C = { dim: '\x1b[2m', green: '\x1b[32m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m' };

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${String(text).slice(0, 200)}`);
  return parsed;
}

/** Real metrics gathered earlier via x_search, cached to disk. */
type CachedSeed = { handle: string; breakdown?: { tenureMultiplier: number }; credits: number };

function cachedMetrics(): Record<string, { tenureYears: number; medianImpressions: number; recentPosts: number }> {
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'assets/karma-cache.json'), 'utf8')) as Record<string, CachedSeed>;
    const out: Record<string, { tenureYears: number; medianImpressions: number; recentPosts: number }> = {};
    for (const [handle, s] of Object.entries(raw)) {
      // Invert the log factors back to the underlying observations.
      const b: any = (s as any).breakdown ?? {};
      const inv = (f: number) => Math.max(0, Math.round(10 ** ((f ?? 1) - 1) - 1));
      out[handle] = {
        tenureYears: inv(b.tenureMultiplier),
        medianImpressions: inv(b.impressionsMultiplier),
        recentPosts: inv(b.activityMultiplier),
      };
    }
    return out;
  } catch {
    return {};
  }
}

const FALLBACK: Record<string, { tenureYears: number; medianImpressions: number; recentPosts: number }> = {
  elonmusk: { tenureYears: 16, medianImpressions: 2_068_483, recentPosts: 10 },
  paulg: { tenureYears: 16, medianImpressions: 330_000, recentPosts: 10 },
  xai: { tenureYears: 4, medianImpressions: 279_352, recentPosts: 10 },
  naval: { tenureYears: 16, medianImpressions: 180_000, recentPosts: 6 },
  trexkalp: { tenureYears: 1, medianImpressions: 88, recentPosts: 1 },
};

const HARVEST = {
  type: 'function' as const,
  name: 'report_posts',
  description: 'Report claim-shaped posts actually found in search results.',
  parameters: {
    type: 'object',
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            handle: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['handle', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['posts'],
    additionalProperties: false,
  },
};

async function sourcePosts(limit: number): Promise<Array<{ handle: string; text: string }>> {
  const handles = (process.env.SEED_HANDLES ?? 'elonmusk,xai,paulg,nasa,espn,netflix').split(',').map((s) => s.trim());
  const reply = await createResponse({
    model: config.textModel,
    input: [
      {
        role: 'system',
        content:
          'Report only posts you actually see in search results; never invent one. You are stocking a live prediction-market channel, so prefer claims a general audience already has an opinion about — sports, launches, releases, records, box office — and that reality will settle by a date. Avoid anything only a specialist would care about.',
      },
      {
        role: 'user',
        content: `Search X for recent posts from ${handles.map((h) => '@' + h).join(', ')}. Return up to ${limit} containing a falsifiable forward-looking claim. Prefer variety over several posts about one story.`,
      },
    ],
    tools: [{ type: 'x_search', allowed_x_handles: handles.slice(0, 10) }, HARVEST],
    max_output_tokens: 8000,
  });
  const call = extractFunctionCalls(reply).find((c) => c.name === 'report_posts');
  if (!call) return [];
  try {
    const posts = JSON.parse(call.arguments).posts;
    return Array.isArray(posts) ? posts.filter((p: any) => p?.text && p?.handle).slice(0, limit) : [];
  } catch {
    return [];
  }
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const rand = mulberry32(20260808);
  console.log(`\nseeding ${ENGINE}\n`);

  // ---- accounts, from real observed history ----
  const metrics = { ...FALLBACK, ...cachedMetrics() };
  const accounts: Array<{ userId: string; handle: string }> = [];

  for (const [handle, m] of Object.entries(metrics)) {
    const createdAt = new Date(Date.now() - m.tenureYears * 365.25 * 864e5).toISOString();
    // The engine wants impression SAMPLES and takes the median itself, so give
    // it a spread around the observed median rather than the median restated.
    const samples = Array.from({ length: 9 }, (_, i) => Math.max(0, Math.round(m.medianImpressions * (0.55 + i * 0.11))));
    try {
      const res = await post('/api/accounts', {
        xUserId: `x_${handle}`,
        handle,
        accountCreatedAt: createdAt,
        postCount: Math.max(1, m.recentPosts * 400),
        impressionSamples: samples,
      });
      const seed = res.account?.karmaSeed ?? res.account?.seed ?? res.karma?.seed ?? '?';
      const bal = res.account?.availableBalance ?? '?';
      console.log(`${C.green}account${C.reset} @${handle.padEnd(10)} seed ${String(seed).padStart(6)}  balance ${bal}`);
      accounts.push({ userId: `x_${handle}`, handle });
    } catch (err) {
      console.log(`${C.red}account @${handle} failed:${C.reset} ${err instanceof Error ? err.message : err}`);
    }
  }

  if (accounts.length === 0) throw new Error('no accounts created; cannot seed markets');

  // ---- markets, from real posts ----
  console.log('');
  let posts: Array<{ handle: string; text: string }> = [];
  try {
    posts = await sourcePosts(6);
  } catch (err) {
    console.log(`${C.dim}post search failed: ${err instanceof Error ? err.message : err}${C.reset}`);
  }
  console.log(`${C.dim}found ${posts.length} claim-shaped posts${C.reset}`);

  const marketIds: string[] = [];
  for (const [i, p] of posts.entries()) {
    try {
      const res = await post('/api/markets', {
        sourcePost: {
          id: `seed_${Date.now()}_${i}`,
          url: `https://x.com/${p.handle}/status/${Date.now()}${i}`,
          text: p.text,
          authorId: `x_${p.handle}`,
          authorHandle: p.handle,
          createdAt: new Date().toISOString(),
        },
        creatorUserId: accounts[0]!.userId,
      });
      const m = res.market;
      marketIds.push(m.id);
      console.log(`${C.cyan}market ${C.reset}${m.question.slice(0, 84)}`);
    } catch (err) {
      console.log(`${C.dim}  declined @${p.handle}: ${String(err instanceof Error ? err.message : err).slice(0, 130)}${C.reset}`);
    }
  }

  if (marketIds.length === 0) {
    console.log(`\n${C.red}no markets created${C.reset} — the channel will have nothing to report.`);
    return;
  }

  // ---- synthetic trading so prices move ----
  console.log('');
  const beliefs = new Map<string, number>();
  let trades = 0;
  for (let round = 0; round < 7; round++) {
    for (const mid of marketIds) {
      const acct = accounts[Math.floor(rand() * accounts.length)]!;
      const key = `${acct.userId}:${mid}`;
      if (!beliefs.has(key)) beliefs.set(key, Math.min(0.95, Math.max(0.05, rand())));
      const belief = beliefs.get(key)!;
      try {
        const snap = await (await fetch(`${ENGINE}/api/markets/${mid}`)).json();
        const price = snap.priceYes ?? 0.5;
        const edge = belief - price;
        if (Math.abs(edge) < 0.04) continue;
        await post(`/api/markets/${mid}/trades`, {
          userId: acct.userId,
          outcome: edge > 0 ? 'YES' : 'NO',
          credits: Math.round(20 + Math.abs(edge) * 120),
        });
        trades++;
      } catch {
        /* insufficient balance or closed; skip */
      }
    }
  }
  console.log(`${C.green}${trades} trades placed${C.reset} across ${marketIds.length} markets\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
