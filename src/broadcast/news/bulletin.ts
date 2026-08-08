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

export type Beat = {
  line: string;
  speaker: Speaker;
  treatment: Treatment;
  marketId?: string;
  kicker: string;
  segment: SegmentId;
  /** True for the beat that gets a video render. */
  onCamera: boolean;
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
            speaker: { type: 'string', enum: ['anchor', 'vera', 'kane'], description: 'Who says it. Use only the speakers allowed for this segment.' },
            market_id: { type: 'string', description: 'Contract this refers to, or empty.' },
          },
          required: ['line', 'speaker', 'market_id'],
          additionalProperties: false,
        },
      },
    },
    required: ['beats'],
    additionalProperties: false,
  },
};

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
  const rapid = seg.treatment === 'rapid' || seg.treatment === 'tease';

  if (markets.length === 0) {
    return [{
      line: 'The book is still opening, so there is as yet nothing for anyone to disagree about.',
      speaker: 'anchor', treatment: seg.treatment, kicker: seg.badge, segment: segmentId, onCamera: false,
    }];
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

  // A two-hander is written as one exchange so the sides actually answer each
  // other, then split into beats — writing them independently produces two
  // monologues rather than a debate.
  const speakerRule =
    seg.speakers.length > 1
      ? `This is a two-hander. Write exactly ${seg.beats} beats alternating ${seg.speakers.join(' then ')}, starting with ${seg.speakers[0]}. The second speaker must actually answer the first.`
      : `All beats are spoken by ${seg.speakers[0]}.`;

  const voice = VOICES[seg.speakers[0]!].replace('{LENGTH}', lengthRule(ANCHOR_SECONDS, rapid));
  const secondVoice = seg.speakers[1] ? `\n\nThe other speaker:\n${VOICES[seg.speakers[1]].replace('{LENGTH}', lengthRule(ANCHOR_SECONDS, rapid))}` : '';

  const reply = await createResponse({
    model: config.textModel,
    input: [
      { role: 'system', content: `${voice}${secondVoice}\n\nSEGMENT — ${seg.badge}\n${seg.brief}\n\n${speakerRule}` },
      {
        role: 'user',
        content: [
          'The book:',
          book,
          seg.needsTraders ? `\nBalances:\n${balances}` : '',
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
        marketId: b.market_id || undefined,
        kicker: seg.badge,
        segment: segmentId,
        // Two-handers put every beat on camera; otherwise only the opener does,
        // which keeps the video spend proportional to what it buys.
        onCamera: seg.speakers.length > 1 ? true : Boolean(seg.anyOnCamera) && i === 0,
      };
    })
    .filter((b) => b.line.length > 0);
}
