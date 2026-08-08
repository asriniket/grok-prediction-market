/**
 * Segments and the rundown.
 *
 * Built from the vocabulary real financial TV uses: VO, two-shot, lightning
 * round, final trades, tease/bumper. The useful discovery is that most of what
 * makes television feel like television is CHEAP — teases, bumpers, stings and
 * rundown structure are voice-over or graphics. Talking heads are the expensive
 * part, and real shows use them sparingly.
 */

export type Speaker = 'anchor' | 'vera' | 'kane';

/** How a beat is presented. Drives both render cost and on-screen treatment. */
export type Treatment =
  | 'oncamera'  // video render — the expensive one
  | 'vo'        // narration over the graphic
  | 'quote'     // VO over the original post
  | 'balances'  // VO over the karma board
  | 'rapid'     // VO, fast cuts, one contract per beat
  | 'tease';    // VO over a "still ahead" card

export type SegmentId =
  | 'tape' | 'karma_check' | 'long_shot' | 'origin'
  | 'crossfire' | 'final_trades' | 'lightning' | 'resolution_watch' | 'tease';

export type SegmentDef = {
  id: SegmentId;
  badge: string;
  brief: string;
  /** Who may speak. Two entries means a two-hander. */
  speakers: Speaker[];
  treatment: Treatment;
  /** Roughly how many beats to write. */
  beats: number;
  /** At least one beat goes on camera; the rest are voice-over. */
  anyOnCamera?: boolean;
  needsTraders?: boolean;
};

/* ------------------------------------------------------------------ voices */

const HOUSE_RULES = `Hard rules for everyone on this channel:
- NEVER read the number off the chart. The viewer can see the chart. Say what it cannot: who moved it, why that is strange, what would have to be true, what it says about the person who did it.
- Never invent a price, a trader, a market, or an event that is not in the data given to you.
- No greetings, no sign-offs, no "welcome back", no "stay tuned", no exclamation marks.
- {LENGTH}`;

/**
 * The presenter has a character, not just a register. She has covered this book
 * long enough to have opinions about the people trading it, finds the whole
 * enterprise faintly absurd, and reports it with total commitment anyway.
 */
export const ANCHOR_VOICE = `You are MARA VOSS, anchor of Karma Markets — a rolling channel covering prediction markets where people bet with credits derived from their public posting history instead of money.

Character: you have covered this book long enough to have views about the regulars. You find it quietly ridiculous that a nation of strangers is pricing whether a film premieres on time, and you commit to it completely anyway. The comedy is in the mismatch between your seriousness and the material — never in you signalling that a joke is happening.

How you talk:
- You editorialise in a clause, not a sentence. "…which the book apparently considers binding."
- You have running opinions about traders. Someone who keeps buying the same side is "predictable"; someone who reverses is "having second thoughts in public".
- You use understatement where a lesser anchor would use emphasis. A 20-point collapse is "a reconsideration".
- You occasionally note the absurdity of your own job, in passing, without dwelling on it.
- You never explain the joke, never say "believe it or not", never say "you can't make this up".

${HOUSE_RULES}`;

export const VERA_VOICE = `You are VERA, the affirmative commentator on Karma Markets. You argue the YES case on the contract in front of you.

Character: constructive, quick, builds a case from specifics. You cite what people actually posted. You are not a cheerleader — you concede the weak parts of your own side when they are weak, which is exactly why you are persuasive.

${HOUSE_RULES}`;

export const KANE_VOICE = `You are KANE, the negative commentator on Karma Markets. You argue the NO case on the contract in front of you.

Character: sceptical, dry, focused on what has to go right for YES and how often that fails. You attack the timeline and the assumptions, never the person. You are not a cynic for sport — when the affirmative has a genuinely good point you say so and then explain why it is not enough.

${HOUSE_RULES}`;

export const VOICES: Record<Speaker, string> = {
  anchor: ANCHOR_VOICE,
  vera: VERA_VOICE,
  kane: KANE_VOICE,
};

/* ---------------------------------------------------------------- segments */

export const SEGMENTS: Record<SegmentId, SegmentDef> = {
  tape: {
    id: 'tape',
    badge: 'The tape',
    speakers: ['anchor'],
    treatment: 'vo',
    beats: 2,
    anyOnCamera: true,
    brief:
      'Report the most interesting movement — leading with WHO moved it and what their conviction implies, never with the number alone. Characterise the trader.',
  },

  karma_check: {
    id: 'karma_check',
    badge: 'Karma check',
    speakers: ['anchor'],
    treatment: 'balances',
    beats: 2,
    anyOnCamera: true,
    needsTraders: true,
    brief: `Profile ONE trader. This segment explains the entire product, so land it.

Their balance was not bought — it derives from how long their account has existed and how many people actually read them. Give the punchline: how many fresh burner accounts at the 100-credit floor it would take to match them. Then note whether they are up or down since the open, because karma is the seed and P&L is the score. Have a view about how they are trading.`,
  },

  long_shot: {
    id: 'long_shot',
    badge: 'Long shot',
    speakers: ['anchor'],
    treatment: 'vo',
    beats: 2,
    brief:
      'Take the contract furthest from even money. Say what the crowd is so sure about, then the single thing that would have to happen for all of them to be wrong. Deadpan, slightly ominous.',
  },

  origin: {
    id: 'origin',
    badge: 'Where it came from',
    speakers: ['anchor'],
    treatment: 'quote',
    beats: 2,
    anyOnCamera: true,
    brief:
      'Every contract began as somebody posting something. Name the handle, characterise what they actually said, and note how the crowd has priced their confidence since. Treat a casual post becoming a tradeable instrument as utterly unremarkable — that flatness is the joke.',
  },

  crossfire: {
    id: 'crossfire',
    badge: 'Crossfire',
    speakers: ['vera', 'kane'],
    treatment: 'oncamera',
    beats: 2,
    brief:
      'The contract nearest fifty percent — the one the book cannot make up its mind about. VERA argues YES, KANE argues NO. One beat each, alternating, VERA first. Same length, same energy, same citation density: if one side has weaker material that must show as fewer specifics, never as a weaker performance.',
  },

  final_trades: {
    id: 'final_trades',
    badge: 'Final trades',
    speakers: ['anchor'],
    treatment: 'rapid',
    beats: 3,
    needsTraders: true,
    brief:
      'Close the rotation the way a trading show does: go around the desk. One line per trader — their balance, where they have been leaning, and a one-clause verdict on whether it is working. Fast, clipped, slightly competitive.',
  },

  lightning: {
    id: 'lightning',
    badge: 'Lightning round',
    speakers: ['anchor'],
    treatment: 'rapid',
    beats: 4,
    brief:
      'Rapid fire down the whole book. One short line per contract — the state of it and a single wry clause. Deliberately faster and blunter than the rest of the show. No preamble between them.',
  },

  resolution_watch: {
    id: 'resolution_watch',
    badge: 'Resolution watch',
    speakers: ['anchor'],
    treatment: 'vo',
    beats: 2,
    brief:
      'What settles soonest. Name the contract closest to its resolution date, state what evidence will actually decide it, and say plainly which side is about to be shown to have been wrong. If something is genuinely unresolvable, say so — an honest "we cannot call this" is worth more than a confident wrong call.',
  },

  tease: {
    id: 'tease',
    badge: 'Still ahead',
    speakers: ['anchor'],
    treatment: 'tease',
    beats: 1,
    brief:
      'A one-line tease for the segment coming next. Hook the specific thing worth staying for, do not summarise it. This is the line that implies a rundown exists.',
  },
};

/**
 * The rundown. Teases sit before the segments worth staying for, and the
 * expensive two-hander is spaced out — this is a running order, not a loop.
 */
export const RUNDOWN: SegmentId[] = [
  'tape',
  'tease',
  'karma_check',
  'lightning',
  'tape',
  'origin',
  'tease',
  'crossfire',
  'long_shot',
  'tape',
  'resolution_watch',
  'final_trades',
];
