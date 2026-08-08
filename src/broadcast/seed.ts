import { loadConfig } from '../config.js';
import { PostgresStore } from '../infrastructure/postgres-store.js';
import { config as broadcastConfig } from './config.js';
import { createResponse, extractFunctionCalls } from './xai/rest.js';

/**
 * Seeds the shared book so the channel has something to report.
 *
 *   npm run seed
 *
 * Writes through the STORE, not the HTTP API. Trading is session-gated for real
 * users — a caller-supplied user id is deliberately not trusted — and that is
 * the correct rule for a request path. A seeding tool is not a request path, so
 * it uses the same store the server does rather than trying to forge a session.
 *
 * Accounts are seeded from tenure and impression samples actually observed on X,
 * so the engine computes real karma instead of being handed a number. The
 * trading on top is SYNTHETIC: each account gets a private belief per market and
 * trades toward it. Balances are real; the behaviour is simulated, and the demo
 * should say so.
 */

const C = { dim: '\x1b[2m', green: '\x1b[32m', cyan: '\x1b[36m', red: '\x1b[31m', reset: '\x1b[0m' };

/** Observed on X earlier: tenure in years, median impressions, recent post rate. */
const PEOPLE: Record<string, { tenureYears: number; medianImpressions: number; posts: number }> = {
  elonmusk: { tenureYears: 16, medianImpressions: 2_068_483, posts: 72_000 },
  paulg: { tenureYears: 16, medianImpressions: 330_000, posts: 41_000 },
  naval: { tenureYears: 16, medianImpressions: 180_000, posts: 28_000 },
  xai: { tenureYears: 4, medianImpressions: 279_352, posts: 3_400 },
  trexkalp: { tenureYears: 1, medianImpressions: 88, posts: 40 },
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
          properties: { handle: { type: 'string' }, text: { type: 'string' } },
          required: ['handle', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['posts'],
    additionalProperties: false,
  },
};

const CLAIM = {
  type: 'function' as const,
  name: 'propose_claim',
  description: 'Turn a post into a resolvable binary question, or decline.',
  parameters: {
    type: 'object',
    properties: {
      marketable: { type: 'boolean' },
      question: { type: 'string', description: 'Self-contained yes/no question, 12-240 chars, ends with a question mark.' },
      resolution_criteria: { type: 'array', items: { type: 'string' }, description: '1-4 criteria, each at least 8 chars. Say what makes it NO too.' },
      closes_at: { type: 'string', description: 'ISO 8601 datetime.' },
      rationale: { type: 'string' },
    },
    required: ['marketable', 'question', 'resolution_criteria', 'closes_at', 'rationale'],
    additionalProperties: false,
  },
};

async function sourcePosts(limit: number): Promise<Array<{ handle: string; text: string }>> {
  const handles = (process.env.SEED_HANDLES ?? 'elonmusk,xai,paulg,nasa,espn,netflix').split(',').map((s) => s.trim());
  const reply = await createResponse({
    model: broadcastConfig.textModel,
    input: [
      {
        role: 'system',
        content:
          'Report only posts you actually see in search results; never invent one. You are stocking a live prediction-market channel, so prefer claims a general audience already has an opinion about — sports, launches, releases, records, box office — that reality will settle by a date.',
      },
      {
        role: 'user',
        content: `Search X for recent posts from ${handles.map((h) => '@' + h).join(', ')}. Return up to ${limit} with a falsifiable forward-looking claim. Prefer variety over several posts about one story.`,
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

async function toClaim(post: { handle: string; text: string }) {
  const reply = await createResponse({
    model: broadcastConfig.textModel,
    input: [
      {
        role: 'system',
        content:
          'Turn one post into one binary prediction-market question. It must be self-contained, name entities explicitly, be bounded in time, and say what counts as NO. Decline (marketable=false) if the post has no falsifiable claim — a bad market is worse than no market.',
      },
      { role: 'user', content: `Today is ${new Date().toISOString().slice(0, 10)}.\nPost by @${post.handle}:\n"""${post.text}"""` },
    ],
    tools: [{ type: 'web_search' }, CLAIM],
    max_output_tokens: 6000,
  });
  const call = extractFunctionCalls(reply).find((c) => c.name === 'propose_claim');
  if (!call) return undefined;
  try {
    const a = JSON.parse(call.arguments);
    if (!a.marketable) return undefined;
    const criteria = (Array.isArray(a.resolution_criteria) ? a.resolution_criteria : [])
      .map(String)
      .filter((c: string) => c.length >= 8)
      .slice(0, 4);
    if (criteria.length === 0) return undefined;
    return {
      question: String(a.question).slice(0, 240),
      resolutionCriteria: criteria,
      closesAt: new Date(a.closes_at).toISOString(),
      rationale: String(a.rationale ?? 'seeded').slice(0, 500),
    };
  } catch {
    return undefined;
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
  const store = new PostgresStore(loadConfig().databaseUrl);
  await store.migrate();
  console.log('\nseeding the shared book\n');

  const userIds: string[] = [];
  for (const [handle, m] of Object.entries(PEOPLE)) {
    const xUserId = `x_${handle}`;
    const samples = Array.from({ length: 9 }, (_, i) => Math.max(0, Math.round(m.medianImpressions * (0.55 + i * 0.11))));
    const { account, created } = await store.createAccountIfAbsent({
      xUserId,
      handle,
      accountCreatedAt: new Date(Date.now() - m.tenureYears * 365.25 * 864e5).toISOString(),
      postCount: m.posts,
      impressionSamples: samples,
    });
    userIds.push(xUserId);
    console.log(
      `${C.green}account${C.reset} @${handle.padEnd(10)} seed ${String(Math.round(account.karmaSeed)).padStart(5)}  balance ${String(Math.round(account.availableBalance)).padStart(5)}${created ? '' : C.dim + '  (existing)' + C.reset}`,
    );
  }

  console.log('');
  let posts: Array<{ handle: string; text: string }> = [];
  try {
    posts = await sourcePosts(6);
  } catch (err) {
    console.log(`${C.dim}post search failed: ${err instanceof Error ? err.message : err}${C.reset}`);
  }
  console.log(`${C.dim}found ${posts.length} claim-shaped posts${C.reset}`);

  const marketIds: string[] = [];
  for (const [i, post] of posts.entries()) {
    try {
      const claim = await toClaim(post);
      if (!claim) {
        console.log(`${C.dim}  ⊘ @${post.handle}: no falsifiable claim${C.reset}`);
        continue;
      }
      const market = await store.createMarket({
        sourcePost: {
          id: `seed_${Date.now()}_${i}`,
          url: `https://x.com/${post.handle}/status/${Date.now()}${i}`,
          text: post.text,
          authorId: `x_${post.handle}`,
          authorHandle: post.handle,
          createdAt: new Date().toISOString(),
        },
        creatorUserId: userIds[0]!,
        question: claim.question,
        resolutionCriteria: claim.resolutionCriteria,
        closesAt: claim.closesAt,
        liquidityB: 200,
      });
      marketIds.push(market.id);
      console.log(`${C.cyan}market ${C.reset}${market.question.slice(0, 82)}`);
    } catch (err) {
      console.log(`${C.dim}  ✗ @${post.handle}: ${String(err instanceof Error ? err.message : err).slice(0, 110)}${C.reset}`);
    }
  }

  // Include anything already on the book so an existing market also gets flow.
  for (const m of await store.listMarkets(20)) {
    if (m.status === 'OPEN' && !marketIds.includes(m.id)) marketIds.push(m.id);
  }
  if (marketIds.length === 0) {
    console.log(`\n${C.red}no open markets${C.reset} — nothing to trade.\n`);
    await store.close();
    return;
  }

  console.log('');
  const beliefs = new Map<string, number>();
  let trades = 0;
  for (let round = 0; round < 6; round++) {
    for (const marketId of marketIds) {
      const userId = userIds[Math.floor(rand() * userIds.length)]!;
      const key = `${userId}:${marketId}`;
      if (!beliefs.has(key)) beliefs.set(key, Math.min(0.94, Math.max(0.06, rand())));
      try {
        const snap = await store.getMarketSnapshot(marketId);
        const edge = beliefs.get(key)! - snap.priceYes;
        if (Math.abs(edge) < 0.05) continue;
        await store.buy({ marketId, userId, outcome: edge > 0 ? 'YES' : 'NO', credits: Math.round(25 + Math.abs(edge) * 150) });
        trades++;
      } catch {
        /* closed, or out of balance */
      }
    }
  }
  console.log(`${C.green}${trades} trades${C.reset} across ${marketIds.length} markets`);

  for (const m of await store.listMarkets(20)) {
    const s = await store.getMarketSnapshot(m.id);
    console.log(`  ${(s.priceYes * 100).toFixed(1).padStart(5)}%  ${m.question.slice(0, 68)}`);
  }
  console.log('');
  await store.close();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
