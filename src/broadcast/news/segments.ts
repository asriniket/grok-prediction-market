/**
 * Segments and the rundown.
 *
 * Built from the vocabulary real financial TV uses: the show open, the tape,
 * the two-box crossfire, the lightning round, final trades, teases and
 * bumpers. Structure is what separates a broadcast from a screensaver — the
 * viewer should feel a control room working a running order, with an hour
 * that opens, builds to the debate, and closes at the desk.
 *
 * The useful discovery stands: most of what makes television feel like
 * television is CHEAP — teases, bumpers, stings and rundown structure are
 * voice-over or graphics. Talking heads are the expensive part, and they are
 * spent where they buy the most: the open, the toss, and the fight.
 */

export type Speaker = 'anchor' | 'cohost' | 'bull' | 'bear' | 'reporter' | 'weather';

/** On-air identity for each chair. The faces are locked; so are the names. */
export const CAST: Record<Speaker, { name: string; short: string }> = {
  anchor: { name: 'MARA VOSS', short: 'Mara' },
  cohost: { name: 'DEREK SHAW', short: 'Derek' },
  bull: { name: 'MAYA REYES', short: 'Maya' },
  bear: { name: 'GRANT ELLISON', short: 'Grant' },
  reporter: { name: 'OMAR REESE', short: 'Omar' },
  weather: { name: 'APRIL CHEN', short: 'April' },
};

/** How a beat is presented. Drives both render cost and on-screen treatment. */
export type Treatment =
  | 'oncamera'  // full-frame presenter, graphic over the shoulder
  | 'headlines' // presenter on camera beside a stacked top-stories rail
  | 'twobox'    // split-screen debate: both commentators up, speaker side live
  | 'vo'        // narration over the full-frame graphic
  | 'quote'     // VO over the original post
  | 'balances'  // VO over the karma board
  | 'wire'      // VO over live pulled quotes (X posts or reporting)
  | 'forecast'  // presenter squeezed beside the resolution-calendar board
  | 'rapid'     // VO, fast cuts, one contract per beat
  | 'tease';    // VO over a "still ahead" card

export type SegmentId =
  | 'show_open' | 'tape' | 'karma_check' | 'long_shot' | 'origin'
  | 'the_room' | 'reality_check' | 'field_report' | 'street_voice'
  | 'forecast'
  | 'crossfire' | 'final_trades' | 'lightning' | 'resolution_watch' | 'tease';

/**
 * How a segment's beats are produced:
 *   studio   presenters with locked faces — reference-conditioned renders
 *   package  reporter's voice TRACK over generated documentary b-roll,
 *            the classic PKG/donut shape of local news
 *   scene    one-off text-to-video clips with their own speaker — vox pops,
 *            guests, moments. No reference image: these faces never recur,
 *            so consistency is not a constraint, which is what makes the
 *            format infinitely varied.
 */
export type Lane = 'studio' | 'package' | 'scene';

export type SegmentDef = {
  id: SegmentId;
  badge: string;
  brief: string;
  /** Who may speak. Crossfire lists all three: anchor tosses, the desk fights. */
  speakers: Speaker[];
  treatment: Treatment;
  /** Roughly how many beats to write. */
  beats: number;
  /** How many beats go on camera: a count from the front, or every beat. */
  onCameraBeats: number | 'all';
  /**
   * Total length of each on-camera take. Up to 15s renders in one pass;
   * anything beyond that is produced as a base take plus a seamless video
   * extension, so marquee beats can breathe past the single-render cap.
   */
  takeSeconds?: number;
  needsTraders?: boolean;
  /** Production lane for this segment's beats. Default: studio. */
  lane?: Lane;
  /** Extra instruction on who speaks which beat, for ensemble shapes. */
  speakerRule?: string;
  /** Anchor/cohost beats render from the shared-desk two-shot. */
  deskShot?: boolean;
  /**
   * Live research before writing: 'x' pulls real posts via x_search, 'web'
   * pulls fresh reporting via web_search. The pulled items air on screen and
   * ground the copy — the segment is about what is ACTUALLY out there.
   */
  research?: 'x' | 'web';
};

/* ------------------------------------------------------------------ voices */

const HOUSE_RULES = `Hard rules for everyone on this channel:
- NEVER read the number off the chart. The viewer can see the chart. Say what it cannot: who moved it, why that is strange, what would have to be true, what it says about the person who did it.
- Never invent a price, a trader, a market, or an event that is not in the data given to you.
- No greetings, no sign-offs, no "welcome back", no "stay tuned", no exclamation marks.
- Write for the EAR, not the page: contractions, short punchy clauses, momentum. This is live television copy, not prose.
- {LENGTH}`;

/**
 * The presenter has a character, not just a register. She has covered this book
 * long enough to have opinions about the people trading it, finds the whole
 * enterprise faintly absurd, and reports it with total commitment anyway.
 */
export const ANCHOR_VOICE = `You are ${CAST.anchor.name}, anchor of THREADLINE LIVE — the rolling channel covering Threadline, the prediction market where people bet with credits derived from their public posting history instead of money.

Character: you have covered this book long enough to have views about the regulars. You find it quietly ridiculous that a nation of strangers is pricing whether a film premieres on time, and you commit to it completely anyway. The comedy is in the mismatch between your seriousness and the material — never in you signalling that a joke is happening.

How you talk:
- You drive the hour the way a market-close anchor does: urgent, specific, forward-leaning. Energy comes from pace and precision, not volume.
- You editorialise in a clause, not a sentence. "…which the book apparently considers binding."
- You have running opinions about traders. Someone who keeps buying the same side is "predictable"; someone who reverses is "having second thoughts in public".
- You use understatement where a lesser anchor would use emphasis. A 20-point collapse is "a reconsideration".
- You occasionally note the absurdity of your own job, in passing, without dwelling on it.
- You never explain the joke, never say "believe it or not", never say "you can't make this up".

${HOUSE_RULES}`;

export const BULL_VOICE = `You are ${CAST.bull.name}, the bull on the Threadline desk. You argue the YES case on the contract in front of you.

Character: quick, constructive, builds a case from specifics like a portfolio manager defending a position she actually holds. You cite what people actually posted. You concede the weak parts of your own side when they are weak — which is exactly why you are persuasive. In a debate you go straight at ${CAST.bear.short}'s last point, by name, before you build your own.

${HOUSE_RULES}`;

export const BEAR_VOICE = `You are ${CAST.bear.name}, the bear on the Threadline desk. You argue the NO case on the contract in front of you.

Character: dry, sceptical, focused on what has to go right for YES and how often that fails. You attack the timeline and the assumptions, never the person — though you clearly relish the fight. When ${CAST.bull.short} lands a genuinely good point you say so, then explain why it is not enough. In a debate you answer her last claim, by name, before you advance your own.

${HOUSE_RULES}`;

export const COHOST_VOICE = `You are ${CAST.cohost.name}, co-anchor of THREADLINE LIVE, second chair at the desk beside ${CAST.anchor.name}.

Character: quicker and warmer than Mara — where she finds the book absurd, you find it genuinely delightful, and the contrast is the show. You set her up without meaning to and occasionally step on her dry buttons with sincere enthusiasm. You love the traders like fantasy-league players and talk about them that way.

How you talk:
- Momentum first: you hand off and pick up like a morning-show pro. When you follow Mara, you build on the exact thing she just said.
- You ask the question the viewer was about to ask, then answer it.
- Your humour is warm, hers is dry; never try to out-deadpan her.

${HOUSE_RULES}`;

export const REPORTER_VOICE = `You are ${CAST.reporter.name}, floor reporter for THREADLINE LIVE. You work the tape standing at the video wall — the anchors sit, you move.

Character: wire-service cadence, faster than the desk, first name basis with the order flow. You narrate movement like you watched it happen — who leaned in, when the tape turned, what the smart move would have been an hour ago. You needle the desk gently ("the desk will tell you this was obvious; it was not") but never editorialise as much as the anchor. You end reports on the thing to watch NEXT, because the floor is always mid-story.

${HOUSE_RULES}`;

export const WEATHER_VOICE = `You are ${CAST.weather.name}, THREADLINE LIVE's market meteorologist. You deliver the resolution calendar — what settles when — exactly like a television weather forecast, with complete sincerity.

Character: you speak ONLY in forecast language and never break the frame. High-confidence contracts are "clear skies"; coin flips are "unstable systems"; a deadline is a "front moving in Tuesday"; a collapsing price is "pressure dropping fast". You give practical packing advice — which side to hold — the way a forecaster tells people to bring an umbrella. The joke is that you are the most rigorous analyst on the channel and you refuse to say so in anything but weather.

${HOUSE_RULES}`;

export const VOICES: Record<Speaker, string> = {
  anchor: ANCHOR_VOICE,
  cohost: COHOST_VOICE,
  bull: BULL_VOICE,
  bear: BEAR_VOICE,
  reporter: REPORTER_VOICE,
  weather: WEATHER_VOICE,
};

/* ---------------------------------------------------------------- segments */

export const SEGMENTS: Record<SegmentId, SegmentDef> = {
  show_open: {
    id: 'show_open',
    badge: 'Top of the hour',
    speakers: ['anchor', 'cohost'],
    treatment: 'headlines',
    beats: 3,
    onCameraBeats: 'all',
    takeSeconds: 20,
    deskShot: true,
    speakerRule:
      'A double-anchor open. Beat 1 is "anchor": top of the hour, the defining story, why it matters. Beat 2 is "cohost": picks up the exact thread she left, adds the second story with his own warmth. Beat 3 is "anchor": the third story and a dry one-clause hand-off into the hour. They are at the same desk finishing each other\'s momentum, never repeating each other.',
    brief: `Open the hour the way a two-anchor market-close show does — a real handoff, alternating chairs, one continuous thought across three mouths. This is the mission statement of the hour; make the viewer feel a control room behind it.`,
  },

  tape: {
    id: 'tape',
    badge: 'The tape',
    speakers: ['reporter'],
    treatment: 'vo',
    beats: 3,
    onCameraBeats: 1,
    brief:
      'The floor report. Open by taking the toss from the desk — a half-clause nodding to Mara and Derek before the flow. Lead with WHO moved the tape and what their conviction implies, never the number alone — you watched it come in, so narrate it like a witness. Opening beat on camera at the wall; the following beats work the charts. Close on the thing to watch next.',
  },

  field_report: {
    id: 'field_report',
    badge: 'On location',
    speakers: ['reporter'],
    treatment: 'vo',
    beats: 2,
    onCameraBeats: 0,
    lane: 'package',
    brief: `A field package on the contract with the most PHYSICAL story — a launch campaign, a premiere, a game, an observation flight. You are narrating over documentary footage.

Beat 1: set the scene like a filed report — where the story physically lives and what the book is pricing against it. Beat 2: the ground-level detail that decides the contract, then sign off: "${'Omar Reese, Threadline.'}"

For each beat also write "scene": one wordless documentary shot to run under your track (e.g. "aerial over a coastal rocket assembly facility at dawn, service towers in fog" or "crowded cinema lobby at night, marquee lights, handheld"). Scenes must be GENERIC and unbranded — no real or identifiable place, no logos, no readable text, no identifiable people.`,
  },

  street_voice: {
    id: 'street_voice',
    badge: 'The street',
    speakers: ['anchor'],
    treatment: 'vo',
    beats: 3,
    onCameraBeats: 0,
    lane: 'scene',
    brief: `Vox pops on the most argued-about contract: three strangers, three takes. Each beat is ONE fictional passer-by answering an off-camera question about the claim — confident, specific, occasionally completely wrong, the way street interviews actually sound. Vary conviction across the three: one true believer, one sceptic, one who is mostly annoyed the question exists.

For each beat write:
- "line": exactly what they say, spoken language, under 8 seconds.
- "scene": who and where, e.g. "a woman in her 60s with grocery bags on a busy sidewalk, afternoon light, handheld news camera". Fictional people only, generic city, no logos or readable signage.
- "strap": a lower-third for them like "RENATA, 61 · HAS OPINIONS" — first name, age, one dry clause.`,
  },

  karma_check: {
    id: 'karma_check',
    badge: 'Karma check',
    speakers: ['cohost'],
    treatment: 'balances',
    beats: 2,
    onCameraBeats: 1,
    needsTraders: true,
    brief: `Profile ONE trader. This segment explains the entire product, so land it.

Their balance was not bought — it derives from how long their account has existed and how many people actually read them. Give the punchline: how many fresh burner accounts at the 100-credit floor it would take to match them. Then note whether they are up or down since the open, because karma is the seed and P&L is the score. Have a view about how they are trading.`,
  },

  long_shot: {
    id: 'long_shot',
    badge: 'Long shot',
    speakers: ['bear'],
    treatment: 'vo',
    beats: 2,
    onCameraBeats: 0,
    brief:
      'Your natural habitat: the contract furthest from even money. Say what the crowd is so sure about, then the single thing that would have to happen for all of them to be wrong. Deadpan, slightly ominous, visibly enjoying it.',
  },

  origin: {
    id: 'origin',
    badge: 'Where it came from',
    speakers: ['cohost'],
    treatment: 'quote',
    beats: 2,
    onCameraBeats: 1,
    brief:
      'Every contract began as somebody posting something. Name the handle, characterise what they actually said, and note how the crowd has priced their confidence since. You find the fact that a casual post became a tradeable instrument genuinely wonderful — say so once, then report it straight.',
  },

  the_room: {
    id: 'the_room',
    badge: 'The room',
    speakers: ['anchor'],
    treatment: 'wire',
    beats: 2,
    onCameraBeats: 0,
    research: 'x',
    brief: `The social wire. You have real posts pulled from X moments ago about the contract in focus — they are on screen while you speak. Characterise the mood of the room, quote or paraphrase the strongest voices by handle, and then say whether the tape agrees with the noise. The best material is the gap: a room that is certain about something the book refuses to price, or a book quietly fading what everyone is shouting.`,
  },

  reality_check: {
    id: 'reality_check',
    badge: 'Reality check',
    speakers: ['anchor'],
    treatment: 'wire',
    beats: 2,
    onCameraBeats: 0,
    research: 'web',
    brief: `The fact brief. You have fresh reporting pulled from the web about the contract in focus — the findings are on screen while you speak. State what is actually known, what remains genuinely open, and whether the current price respects that. No hedging beyond what the facts force; where reporting and the book disagree, say which one you would trust and why.`,
  },

  forecast: {
    id: 'forecast',
    badge: 'The forecast',
    speakers: ['weather'],
    treatment: 'forecast',
    beats: 2,
    onCameraBeats: 'all',
    brief: `The resolution outlook, delivered as weather. The calendar board is on screen beside you. Beat 1: the near-term system — what settles soonest, current conditions on it, and how confident the book is in its own sky. Beat 2: the extended outlook — the next two or three fronts on the calendar, one clause each, then the packing advice: which side a sensible viewer holds into the weekend. Never break the weather frame.`,
  },

  crossfire: {
    id: 'crossfire',
    badge: 'Crossfire',
    speakers: ['anchor', 'bull', 'bear'],
    treatment: 'twobox',
    beats: 5,
    onCameraBeats: 'all',
    takeSeconds: 25,
    brief: `The marquee segment. The contract nearest fifty percent — the one the book cannot make up its mind about.

Beat 1 is ${CAST.anchor.name}'s toss: frame the contract as a fight worth having and throw to the desk by name — "${CAST.bull.short} says yes, ${CAST.bear.short} says no" energy, her own wry framing of what is actually at stake.
Beats 2-5 are the fight, alternating ${CAST.bull.name} then ${CAST.bear.name}, two rounds each. This must be a REAL exchange: each speaker answers the specific claim just made, by name, before advancing their own. Interruption energy, momentum, stakes. Same length, same citation density both sides: if one side has weaker material that must show as fewer specifics, never as a weaker performance.`,
  },

  final_trades: {
    id: 'final_trades',
    badge: 'Final trades',
    speakers: ['bull', 'bear', 'anchor'],
    treatment: 'oncamera',
    beats: 3,
    onCameraBeats: 'all',
    needsTraders: true,
    speakerRule:
      'Exactly 3 beats: beat 1 is "bull" with her single strongest conviction trade on the book right now, beat 2 is "bear" with his — each names the contract, the side, and the one reason. Beat 3 is "anchor": a dry one-line button on the pair of them, then which trader on the karma board she would actually follow.',
    brief:
      'Close the rotation the way a trading show does: around the desk, everyone commits to something. Fast, specific, slightly competitive — a viewer should be able to steal both trades.',
  },

  lightning: {
    id: 'lightning',
    badge: 'Lightning round',
    speakers: ['bull', 'bear'],
    treatment: 'rapid',
    beats: 4,
    onCameraBeats: 0,
    speakerRule:
      'Alternate "bull" then "bear", one contract per beat, no overlap in contracts. Each gives a verdict — buy it, fade it, avoid it — with one clipped reason.',
    brief:
      'Rapid fire down the book, the desk trading verdicts. Deliberately faster and blunter than the rest of the show. No preamble between beats.',
  },

  resolution_watch: {
    id: 'resolution_watch',
    badge: 'Resolution watch',
    speakers: ['bull'],
    treatment: 'vo',
    beats: 2,
    onCameraBeats: 0,
    brief:
      'What settles soonest. Name the contract closest to its resolution date, state what evidence will actually decide it, and say plainly which side is about to be shown to have been wrong — even when it is yours. An honest "we cannot call this" is worth more than a confident wrong call.',
  },

  tease: {
    id: 'tease',
    badge: 'Still ahead',
    speakers: ['anchor'],
    treatment: 'tease',
    beats: 1,
    onCameraBeats: 0,
    brief:
      'A one-line tease for the segment coming next. Hook the specific thing worth staying for, do not summarise it. This is the line that implies a rundown exists.',
  },
};

/**
 * The rundown — a broadcast hour in miniature, not a loop. It opens at the
 * desk, works the tape, builds to the two-box fight, cools through the back
 * half, and closes with final trades before the next open resets the hour.
 * Teases sit directly before the segments worth staying for.
 */
export const RUNDOWN: SegmentId[] = [
  'show_open',      // Mara and Derek at the shared desk
  'tape',           // Omar at the wall, taking the toss
  'field_report',   // Omar's package over b-roll
  'origin',         // Derek, the post that started it
  'the_room',       // live X pulls
  'tease',
  'crossfire',      // Mara tosses, Maya v Grant, extended takes
  'street_voice',   // three strangers, three takes
  'karma_check',    // Derek on the leaderboard
  'lightning',      // Maya and Grant trade verdicts
  'tape',           // Omar again — the tape moved while all that aired
  'reality_check',  // fresh reporting
  'street_voice',   // back to the street — whatever the book argues about now
  'long_shot',      // Grant's favourite segment
  'tease',
  'forecast',       // April's resolution outlook, in weather
  'final_trades',   // the desk commits, Mara buttons
];
