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
  affirmative: { name: 'VERA', hair: 'short dark hair', jacket: 'a charcoal jacket' },
  negative: { name: 'KANE', hair: 'short light hair', jacket: 'a slate jacket' },
};

/**
 * Deliberately neutral: no warmth cues, no lighting asymmetry, no camera
 * favouritism. "Even, neutral" appears for both because the whole point is
 * that neither messenger is more appealing than the other.
 */
const REFERENCE_TEMPLATE = `Studio portrait of a fictional debate commentator named {NAME}. {HAIR}, wearing {JACKET} over a plain shirt. Shoulders-up framing, centered, facing camera directly. Flat neutral grey seamless backdrop. Even, neutral three-point lighting with no rim light and no colour cast. Neutral composed expression, mouth closed. Photographic, sharp focus, 50mm lens look. Not a real or identifiable person.`;

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

const ANCHOR_TEMPLATE = `Studio portrait of a fictional television news anchor named ${ANCHOR_NAME}, seated at a modern news desk. Composed professional expression, mouth closed, facing camera directly. Head-and-shoulders framing with the desk edge visible at the bottom. Behind is a softly out-of-focus broadcast studio with cool blue ambient light and faint screen glow. Crisp broadcast lighting on the face. Photographic, sharp focus, 50mm lens look. Not a real or identifiable person.`;

export function anchorReferencePrompt(): string {
  return ANCHOR_TEMPLATE;
}

const LOOP_TEMPLATE = `The commentator speaks steadily to camera with natural mouth movement and small head motion. Static locked-off camera, no zoom, no push in. Lighting and background remain constant and even. Neutral professional delivery, no emphatic gestures.`;

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
