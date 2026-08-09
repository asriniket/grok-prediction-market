import { config } from '../config.js';
import { createResponse, extractFunctionCalls } from '../xai/rest.js';
import { ANCHOR_SECONDS, wordsForSeconds } from './anchor.js';
import { SEGMENTS, VOICES, type SegmentId, type Speaker, type Treatment } from './segments.js';

/**
 * Writes the beats for a segment.
 *
 * A beat is one spoken line plus how it is presented. Segments differ in shape
 * as well as content — a two-hander alternates speakers, a lightning round is
 * four fast lines, a tease is one hook — so the writer returns beats rather
 * than undifferentiated copy.
 */

export type MarketLine = {
  id: string;
  question: string;
  price: number;
  volume: number;
  tradeCount: number;
  status: string;
  sourceHandle: string;
  sourceClaim?: string;
  resolveBy?: string;
  delta?: number;
  history?: number[];
};

export type TraderLine = { handle: string; credits: number; seedCredits: number };

/** One pulled item from live research — a real post or a reported fact. */
export type WireItem = { source: string; text: string };

export type Beat = {
  line: string;
  speaker: Speaker;
  treatment: Treatment;
  marketId?: string;
  kicker: string;
  segment: SegmentId;
  /** True for the beat that gets a video render. */
  onCamera: boolean;
  /** Live-pulled material airing on screen under this segment. */
  wire?: WireItem[];
  /** For package/scene lanes: the shot to generate under or around the line. */
  scene?: string;
  /** Lower-third identity for one-off on-screen characters (vox pops). */
  strap?: string;
};

const TOOL = {
  type: 'function' as const,
  name: 'write_beats',
  description: 'Write the beats for this segment.',
  parameters: {
    type: 'object',
    properties: {
      beats: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line: { type: 'string', description: 'Spoken copy, sized to the length rule in the system prompt.' },
            speaker: { type: 'string', enum: ['anchor', 'cohost', 'bull', 'bear', 'reporter', 'weather'], description: 'Who says it. Use only the speakers allowed for this segment.' },
            market_id: { type: 'string', description: 'Contract this refers to, or empty.' },
            scene: { type: 'string', description: 'Only when the segment brief asks for a scene: the shot to generate. Empty string otherwise.' },
            strap: { type: 'string', description: 'Only when the segment brief asks for a strap: the on-screen lower third for a one-off character. Empty string otherwise.' },
          },
          required: ['line', 'speaker', 'market_id', 'scene', 'strap'],
          additionalProperties: false,
        },
      },
    },
    required: ['beats'],
    additionalProperties: false,
  },
};

const WIRE_TOOL = {
  type: 'function' as const,
  name: 'report_wire',
  description: 'Report items actually found in search results. Never invent one.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'The @handle (X) or publication (web) this came from.' },
            text: { type: 'string', description: 'The post or finding, quoted or tightly paraphrased, max 140 chars.' },
          },
          required: ['source', 'text'],
          additionalProperties: false,
        },
      },
      read: { type: 'string', description: 'One sentence: where the room / the reporting actually stands.' },
    },
    required: ['items', 'read'],
    additionalProperties: false,
  },
};

/**
 * Live research pass for wire segments: pull what X or the web is ACTUALLY
 * saying about the contract before a word of copy is written. The pulled
 * items air on screen, so hallucinated material would be visibly fake —
 * which is exactly why the harvest is tool-verified search, not memory.
 */
async function researchWire(
  kind: 'x' | 'web',
  market: MarketLine,
): Promise<{ items: WireItem[]; read: string } | undefined> {
  const ask =
    kind === 'x'
      ? `Search X for recent posts about this claim and the conversation around it:\n"${market.question}"\nIt originated from @${market.sourceHandle}${market.sourceClaim ? ` who posted: "${market.sourceClaim.slice(0, 200)}"` : ''}.\nReport up to 4 real posts from distinct handles that bear on whether this resolves YES — reactions, evidence, mockery, all fair game.`
      : `Search the web for the latest reporting that bears on this question:\n"${market.question}"\nReport up to 3 findings from distinct publications — concrete facts or statements, not opinions about the market.`;
  const reply = await createResponse({
    model: config.textModel,
    input: [
      {
        role: 'system',
        content:
          'You research for a live markets broadcast. Report only what you actually find in search results; if you find nothing relevant, report an empty items list. Quotes must be short enough to air.',
      },
      { role: 'user', content: ask },
    ],
    tools: [kind === 'x' ? { type: 'x_search' } : { type: 'web_search' }, WIRE_TOOL],
    max_output_tokens: 6000,
  });
  const call = extractFunctionCalls(reply).find((c) => c.name === 'report_wire');
  if (!call) return undefined;
  try {
    const parsed = JSON.parse(call.arguments);
    const items = (Array.isArray(parsed.items) ? parsed.items : [])
      .filter((i: any) => i?.source && i?.text)
      .map((i: any) => ({ source: String(i.source).replace(/^@/, ''), text: String(i.text).slice(0, 160) }))
      .slice(0, 4);
    if (items.length === 0) return undefined;
    return { items, read: String(parsed.read ?? '') };
  } catch {
    return undefined;
  }
}

/** Word budget matched to clip length so copy is never cut off mid-sentence. */
function lengthRule(seconds: number, rapid: boolean): string {
  const w = wordsForSeconds(seconds);
  if (rapid) {
    return `Each line is short and clipped — 12 to 20 words. This is a rapid segment; brevity is the format.`;
  }
  return `Each line runs about ${seconds} seconds spoken, so write ${Math.round(w * 0.8)}-${w} words. Two or three sentences is fine — build a thought rather than stating one fact. Do not exceed it; copy past the budget is cut off mid-sentence on air.`;
}

export async function writeBeats(
  segmentId: SegmentId,
  markets: MarketLine[],
  traders: TraderLine[],
  recent: string[],
  alreadySaid: string[] = [],
  nextSegment?: SegmentId,
): Promise<Beat[]> {
  const seg = SEGMENTS[segmentId];
  // Scene-lane lines are spoken by one-off characters in short clips, so they
  // get the clipped budget even though the treatment is not 'rapid'.
  const rapid = seg.treatment === 'rapid' || seg.treatment === 'tease' || seg.lane === 'scene';

  if (markets.length === 0) {
    return [{
      line: 'The book is still opening, so there is as yet nothing for anyone to disagree about.',
      speaker: 'anchor', treatment: seg.treatment, kicker: seg.badge, segment: segmentId, onCamera: false,
    }];
  }

  // Wire segments research first and write second. No wire, no segment —
  // copy that gestures at on-screen quotes which do not exist reads broken.
  let wire: { items: WireItem[]; read: string } | undefined;
  let wireMarket: MarketLine | undefined;
  if (seg.research) {
    wireMarket =
      seg.research === 'x'
        ? [...markets].sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || b.tradeCount - a.tradeCount)[0]
        : [...markets].filter((m) => m.resolveBy).sort((a, b) => String(a.resolveBy).localeCompare(String(b.resolveBy)))[0] ?? markets[0];
    if (wireMarket) wire = await researchWire(seg.research, wireMarket).catch(() => undefined);
    if (!wire) return [];
  }

  const book = markets
    .map(
      (m) =>
        `${m.id} | ${(m.price * 100).toFixed(1)}% YES${m.delta !== undefined ? ` (${m.delta >= 0 ? '+' : ''}${(m.delta * 100).toFixed(1)} pts)` : ''} | vol ${m.volume} | ${m.tradeCount} trades${m.resolveBy ? ` | resolves ${m.resolveBy}` : ''} | from @${m.sourceHandle}${m.sourceClaim ? ` who posted: "${m.sourceClaim.slice(0, 150)}"` : ''} | ${m.question}`,
    )
    .join('\n');

  const balances = traders.length
    ? traders
        .map((t) => {
          const pl = t.credits - t.seedCredits;
          return `@${t.handle} | ${Math.round(t.credits)} credits | seeded ${Math.round(t.seedCredits)} from public history | ${pl >= 0 ? '+' : ''}${Math.round(pl)} since open | ${Math.ceil(t.seedCredits / 100)} floor burners to match that seed`;
        })
        .join('\n')
    : '(no balance data)';

  // A debate is written as ONE exchange so the sides actually answer each
  // other, then split into beats — writing them independently produces two
  // monologues rather than a fight.
  const speakerRule =
    seg.speakerRule ??
    (seg.id === 'crossfire'
      ? `Beat 1 is spoken by "anchor" — the toss. Beats 2 to ${seg.beats} alternate "bull" then "bear", starting with bull. Each debate beat must answer the specific claim made in the beat before it, addressing the other speaker by name, before advancing its own case.`
      : seg.speakers.length > 1
        ? `This is a two-hander. Write exactly ${seg.beats} beats alternating ${seg.speakers.join(' then ')}, starting with ${seg.speakers[0]}. The second speaker must actually answer the first.`
        : `All beats are spoken by ${seg.speakers[0]}.`);

  // Extended-take segments write to the FULL take length, not the base render.
  const takeSeconds = seg.takeSeconds ?? ANCHOR_SECONDS;
  const voices = seg.speakers
    .map((s, i) => `${i === 0 ? '' : '\n\nAnother voice on this segment:\n'}${VOICES[s].replace('{LENGTH}', lengthRule(takeSeconds, rapid))}`)
    .join('');

  const reply = await createResponse({
    model: config.textModel,
    input: [
      { role: 'system', content: `${voices}\n\nSEGMENT — ${seg.badge}\n${seg.brief}\n\n${speakerRule}` },
      {
        role: 'user',
        content: [
          'The book:',
          book,
          seg.needsTraders ? `\nBalances:\n${balances}` : '',
          wire && wireMarket
            ? `\nContract in focus: ${wireMarket.id} — ${wireMarket.question}\nPulled ${seg.research === 'x' ? 'from X just now' : 'from fresh reporting'} (these air on screen with you):\n${wire.items.map((i) => `- ${seg.research === 'x' ? '@' : ''}${i.source}: "${i.text}"`).join('\n')}\nThe read: ${wire.read}`
            : '',
          recent.length ? `\nRecent activity:\n${recent.slice(-10).join('\n')}` : '',
          nextSegment ? `\nThe segment you are teasing next is: ${SEGMENTS[nextSegment].badge} — ${SEGMENTS[nextSegment].brief}` : '',
          alreadySaid.length
            ? `\nAlready said on air — do not repeat or paraphrase:\n${alreadySaid.slice(-10).map((l) => `- ${l}`).join('\n')}`
            : '',
          `\nWrite ${seg.beats} beat${seg.beats > 1 ? 's' : ''} for ${seg.badge}.`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    tools: [TOOL],
    max_output_tokens: 5000,
  });

  const call = extractFunctionCalls(reply).find((c) => c.name === 'write_beats');
  if (!call) return [];

  let raw: any[];
  try {
    raw = JSON.parse(call.arguments).beats;
    if (!Array.isArray(raw)) return [];
  } catch {
    return [];
  }

  return raw
    .map((b: any, i: number): Beat => {
      const speaker: Speaker = seg.speakers.includes(b.speaker) ? b.speaker : seg.speakers[0]!;
      return {
        line: String(b.line ?? '').trim(),
        speaker,
        treatment: seg.treatment,
        marketId: b.market_id || wireMarket?.id || undefined,
        kicker: seg.badge,
        segment: segmentId,
        // The segment declares how many beats earn a video render, counted from
        // the front — 'all' for the marquee segments, a small count elsewhere.
        onCamera: seg.onCameraBeats === 'all' ? true : i < seg.onCameraBeats,
        wire: wire?.items,
        scene: b.scene ? String(b.scene).trim() || undefined : undefined,
        strap: b.strap ? String(b.strap).trim() || undefined : undefined,
      };
    })
    .filter((b) => b.line.length > 0);
}
