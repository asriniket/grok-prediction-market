/**
 * The symmetry constraint, enforced at the scaffold level.
 *
 * Vividness moves probability estimates. If YES is rendered warm and cinematic
 * and NO is rendered flat, the render has not illustrated the market — it has
 * moved its price. So both champions are generated from ONE template with only
 * the position swapped, and `diffTokens` proves it mechanically rather than
 * leaving it to a reviewer's eye.
 *
 * When one side genuinely has weaker material that must show up as FEWER
 * CITATIONS, never as a less appealing messenger.
 */

export type Side = 'affirmative' | 'negative';

export const CHAMPIONS: Record<Side, { name: string; hair: string; jacket: string }> = {
  // Only these tokens may differ between the two champions. Everything else in
  // the scaffold is byte-identical, which is what makes the pair auditable.
  affirmative: { name: 'MAYA REYES', hair: 'short dark hair', jacket: 'a tailored burgundy blazer' },
  negative: { name: 'GRANT ELLISON', hair: 'short steel-grey hair', jacket: 'a midnight navy suit jacket' },
};

/**
 * The set is a real broadcast bureau — screens, depth, warm key light — because
 * a debate staged against a blank wall reads as a hostage video, not television.
 * Symmetry is preserved by construction: both sides render from this ONE
 * template, so any vividness it adds is added to both messengers equally.
 */
const REFERENCE_TEMPLATE = `Broadcast still of a fictional markets commentator named {NAME} on the set of a live financial television network. {HAIR}, wearing {JACKET} over an open-collar shirt. Seated at a glass panel desk angled slightly toward camera, hands resting naturally on the desk, engaged confident expression, mouth closed. Framed waist-up with headroom, desk edge visible at the bottom. Behind them a floor-to-ceiling wall of out-of-focus trading screens with blue and amber market tickers and a soft evening city-lights glow, strong depth of field. Polished broadcast key light with warm fill and a subtle rim light. Photographic, sharp focus on the face, 35mm lens look. Not a real or identifiable person.`;

/**
 * The anchor is a SEPARATE character from the two debaters, and deliberately so.
 *
 * The symmetry constraint exists to stop presentation moving the price, and it
 * binds the two debaters to each other. The anchor argues no side, so holding
 * them to the debaters' neutral-slate scaffold would be wrong — they should read
 * as a channel presenter, on a news set, with the visual authority the role
 * implies.
 */
export const ANCHOR_NAME = 'MARA VOSS';

const ANCHOR_TEMPLATE = `Broadcast still of a fictional television news anchor named ${ANCHOR_NAME} anchoring the flagship desk of a premier financial news network. Sharp dark blazer over a white blouse, seated at a wide curved glass anchor desk with a brushed-metal nameplate reading "MARA VOSS", hands lightly clasped on the desk, composed confident expression with the hint of a wry smile, mouth closed, facing camera. Framed waist-up, centered, desk edge visible. Behind her a sweeping newsroom set: a giant curved LED video wall with out-of-focus market charts glowing blue and amber, red and white accent lighting along the studio architecture, producers' desks far in the background, strong depth of field. Crisp broadcast key light with warm fill. Photographic, sharp focus on the face, 35mm lens look. Not a real or identifiable person.`;

export function anchorReferencePrompt(): string {
  return ANCHOR_TEMPLATE;
}

/**
 * The floor reporter — the fourth chair. He works STANDING at the video wall,
 * which is what makes his segments read as a different location than the
 * anchor desk even though it is the same virtual studio family.
 */
export const REPORTER_NAME = 'OMAR REESE';

const REPORTER_TEMPLATE = `Broadcast still of a fictional markets floor reporter named ${REPORTER_NAME} reporting for a financial television network. Short black hair, neatly trimmed beard, wearing a navy checked sport coat over an open-collar white shirt, holding a slim tablet loosely in one hand. Standing, framed mid-shot from the waist up, angled slightly toward camera, weight shifted as if mid-report, engaged alert expression, mouth closed. Behind him a towering floor-to-ceiling wall of live market screens with amber and blue tickers and price charts, slightly out of focus, studio floor lighting catching the edge of the frame. Crisp broadcast key light with warm fill. Photographic, sharp focus on the face, 35mm lens look. Not a real or identifiable person.`;

export function reporterReferencePrompt(): string {
  return REPORTER_TEMPLATE;
}

/**
 * The co-anchor — second chair at the flagship desk. Same studio family as
 * the lead anchor's set so cutting between their singles reads as one desk.
 */
export const COHOST_NAME = 'DEREK SHAW';

const COHOST_TEMPLATE = `Broadcast still of a fictional television news co-anchor named ${COHOST_NAME} at the flagship desk of a premier financial news network. Early 40s, short dark hair, light stubble, navy suit with no tie over a crisp pale-blue shirt, seated at a wide curved glass anchor desk angled slightly camera-right, one hand resting on loose notes, warm engaged expression with an easy half-smile, mouth closed, facing camera. Framed waist-up. Behind him the sweeping newsroom set: a giant curved LED video wall with out-of-focus market charts glowing blue and amber, red and white accent lighting along the studio architecture, strong depth of field. Crisp broadcast key light with warm fill. Photographic, sharp focus on the face, 35mm lens look. Not a real or identifiable person.`;

export function cohostReferencePrompt(): string {
  return COHOST_TEMPLATE;
}

const LOOP_TEMPLATE = `The commentator makes their case to camera like a pundit on live financial television: animated, leaning in slightly, natural hand gestures over the desk, expression tracking the argument. Subtle slow push-in. Lighting and background remain constant. Committed, energetic broadcast delivery.`;

function fill(template: string, side: Side): string {
  const c = CHAMPIONS[side];
  return template.replace('{NAME}', c.name).replace('{HAIR}', c.hair).replace('{JACKET}', c.jacket);
}

export function referencePrompt(side: Side): string {
  return fill(REFERENCE_TEMPLATE, side);
}

export function loopPrompt(side: Side): string {
  return fill(LOOP_TEMPLATE, side);
}

/**
 * Words that differ between two prompts, ignoring order. For a symmetric pair
 * this must contain ONLY the champions' identity tokens — anything else is an
 * asymmetry that could move the price.
 */
export function diffTokens(a: string, b: string): string[] {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const aw = words(a);
  const bw = words(b);
  const count = (xs: string[]) => xs.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
  const ca = count(aw);
  const cb = count(bw);
  const diff = new Set<string>();
  for (const [w, n] of ca) if ((cb.get(w) ?? 0) !== n) diff.add(w);
  for (const [w, n] of cb) if ((ca.get(w) ?? 0) !== n) diff.add(w);
  return [...diff].sort();
}

/** Tokens legitimately allowed to differ: the champions' names and appearance. */
export function allowedDiffTokens(): Set<string> {
  const out = new Set<string>();
  for (const c of Object.values(CHAMPIONS)) {
    for (const field of [c.name, c.hair, c.jacket]) {
      for (const w of field.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)) if (w) out.add(w);
    }
  }
  return out;
}

/**
 * Structural check: the two prompts must differ only in identity tokens.
 * Returns offending tokens; empty means the pair is symmetric.
 */
export function symmetryViolations(a: string, b: string): string[] {
  const allowed = allowedDiffTokens();
  return diffTokens(a, b).filter((t) => !allowed.has(t));
}

/**
 * The public audit artifact: log the prompt pair for every market so anyone
 * can check whether it was framed fairly. Generation transparency as market
 * integrity.
 */
export function promptPairArtifact(): {
  affirmative: { reference: string; loop: string };
  negative: { reference: string; loop: string };
  symmetric: boolean;
  violations: string[];
} {
  const aRef = referencePrompt('affirmative');
  const nRef = referencePrompt('negative');
  const aLoop = loopPrompt('affirmative');
  const nLoop = loopPrompt('negative');
  const violations = [...symmetryViolations(aRef, nRef), ...symmetryViolations(aLoop, nLoop)];
  return {
    affirmative: { reference: aRef, loop: aLoop },
    negative: { reference: nRef, loop: nLoop },
    symmetric: violations.length === 0,
    violations,
  };
}
