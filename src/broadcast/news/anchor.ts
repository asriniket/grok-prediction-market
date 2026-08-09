import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { xai } from '../xai/rest.js';
import { config } from '../config.js';
import { loadAnchorReference, loadCohostReference, loadDeskReference, loadLockedReference, loadReporterReference, loadWeatherReference } from '../champions/generate.js';
import type { Speaker } from './segments.js';

/**
 * Anchor clip generation.
 *
 * Grok Imagine 1.5 produces native synchronised audio — including lip-synced
 * dialogue — in the SAME pass as the video. Verified: generated clips carry
 * both a video track and an mp4a/esds audio track.
 *
 * The direction here is deliberately NOT "calm, locked-off, minimal gesture".
 * That produced clips that read as animated ID photos. Financial television is
 * kinetic: presenters lean in, gesture over the desk, and their faces track
 * the meaning of the copy. The camera moves too — studio cameras sit on
 * pedestals and jibs, and a subtle push-in is half of what makes a shot read
 * as broadcast rather than webcam.
 */

export const ANCHOR_MODEL = process.env.ANCHOR_MODEL ?? 'grok-imagine-video-1.5';
/** The extensions endpoint runs its own model id (per docs.x.ai). */
export const EXTEND_MODEL = process.env.EXTEND_MODEL ?? 'grok-imagine-video';

/**
 * Clip length. Grok Imagine tops out at 15s, so the channel runs at the cap —
 * longer takes mean fewer cuts back to graphics and room for copy that builds
 * an actual thought. Cost scales linearly; this is the main spend dial.
 */
export const ANCHOR_SECONDS = Math.min(15, Math.max(4, Number(process.env.ANCHOR_SECONDS ?? 15)));

/**
 * Measured delivery is ~2.6 words/sec. Copy written past the clip length gets
 * cut off mid-sentence, so the writer's word budget is derived from duration
 * rather than guessed.
 */
export const wordsForSeconds = (secs: number) => Math.round(secs * 2.6);

/** The anchor's locked portrait — same face every bulletin, no drift. */
export const anchorReference = () => loadAnchorReference();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AnchorClip = { videoUrl: string; line: string; seconds: number; renderMs: number };

/**
 * Consecutive takes of the same speaker alternate framing. Two identical
 * framings back to back jump-cut; a size change reads as a camera switch,
 * which is how real control rooms hide exactly the same seam.
 */
export type Shot = 'medium' | 'close';
const SHOT_DIRECTION: Record<Shot, string> = {
  medium: 'Medium shot, waist up at the desk, with a very slow subtle push-in.',
  close: 'Medium close-up, chest up at the desk, camera locked off.',
};

/**
 * Delivery direction is fixed per role so each presenter reads as one
 * consistent character — but the character is a television professional in
 * full flight, not a portrait subject reading a statement.
 */
function anchorPrompt(line: string, shot: Shot): string {
  return `${SHOT_DIRECTION[shot]} The news anchor delivers this line to camera with the energy of live financial television — brisk, engaged, natural hand gestures over the desk, eyebrows and expression tracking the meaning of the words, a dry wry edge where the words are wry — with accurate lip sync: "${line}" She is mid-broadcast with more news coming: confident, quick, never flat. The studio set, desk, wardrobe and lighting stay exactly as they are. No on-screen text, no captions, no graphics, no lower thirds.`;
}

/** Commentators are pundits mid-debate, not portrait subjects. */
function commentatorPrompt(line: string, shot: Shot): string {
  return `${SHOT_DIRECTION[shot]} The commentator argues this straight down the lens like a market pundit on live television — leaning in, hands gesturing over the desk, conviction on their face, quick confident pacing, clearly enjoying the fight — with accurate lip sync: "${line}" The set, wardrobe and lighting stay exactly as they are. No on-screen text, no captions, no graphics.`;
}

/** The reporter works standing at the wall — different energy, different verbs. */
const REPORTER_SHOTS: Record<Shot, string> = {
  medium: 'Medium shot, standing at the video wall, with a very slow subtle push-in.',
  close: 'Medium close-up, standing at the video wall, camera locked off.',
};
function reporterPrompt(line: string, shot: Shot): string {
  return `${REPORTER_SHOTS[shot]} The floor reporter delivers this report to camera with wire-service urgency — half-turning to gesture at the wall of screens behind him, tablet in hand, quick confident pacing, mid-story energy — with accurate lip sync: "${line}" The set, wardrobe and lighting stay exactly as they are. No on-screen text, no captions, no graphics.`;
}

/** The co-anchor: same desk energy, warmer register. */
function cohostPrompt(line: string, shot: Shot): string {
  return `${SHOT_DIRECTION[shot]} The co-anchor delivers this line to camera with the energy of live financial television — brisk, warm, engaged, natural hand gestures over the desk, expression tracking the meaning, picking up momentum as if continuing his colleague's thought — with accurate lip sync: "${line}" He is mid-broadcast with more news coming: confident, quick, never flat. The studio set, desk, wardrobe and lighting stay exactly as they are. No on-screen text, no captions, no graphics, no lower thirds.`;
}

/**
 * Desk two-shot direction: both anchors stay in frame at the shared desk —
 * the layout is fixed by the locked reference (the woman frame-left, the man
 * frame-right), so speaker direction addresses them by position.
 */
const DESK_SHOTS: Record<Shot, string> = {
  medium: 'Wide two-shot holding both anchors at the shared desk, very slow subtle push-in.',
  close: 'Two-shot at the shared desk, framed slightly tighter, camera locked off.',
};
function deskPrompt(line: string, speaker: Speaker, shot: Shot): string {
  const talker = speaker === 'anchor' ? 'The woman on the left' : 'The man on the right';
  const listener =
    speaker === 'anchor'
      ? 'the man on the right listens, nodding along, glancing at his notes'
      : 'the woman on the left listens with a dry, attentive expression';
  return `${DESK_SHOTS[shot]} ${talker} delivers this line to camera with live financial-television energy — brisk, engaged, natural gestures over the desk — with accurate lip sync: "${line}" Meanwhile ${listener}. Both anchors remain in frame at the same desk throughout. The studio set, desk, wardrobe and lighting stay exactly as they are. No on-screen text, no captions, no graphics, no lower thirds.`;
}

/** The forecaster presents at her board like weather — open-palm gestures. */
function weatherPrompt(line: string, shot: Shot): string {
  const frame = shot === 'medium'
    ? 'Medium shot, standing beside the forecast wall, very slow subtle push-in.'
    : 'Medium close-up beside the forecast wall, camera locked off.';
  return `${frame} The forecaster presents this like a television weather report — open-palm gestures toward the glowing wall beside her, sweeping an arc as if across a map, bright sincere delivery — with accurate lip sync: "${line}" The set, wardrobe and lighting stay exactly as they are; the wall stays soft with no readable text. No on-screen text, no captions, no graphics.`;
}

/** Reference and direction for whichever speaker has the beat. */
function speakerSetup(speaker: Speaker, line: string, shot: Shot): { url: string; prompt: string } {
  if (speaker === 'anchor') return { url: anchorReference().url, prompt: anchorPrompt(line, shot) };
  if (speaker === 'cohost') return { url: loadCohostReference().url, prompt: cohostPrompt(line, shot) };
  if (speaker === 'reporter') return { url: loadReporterReference().url, prompt: reporterPrompt(line, shot) };
  if (speaker === 'weather') return { url: loadWeatherReference().url, prompt: weatherPrompt(line, shot) };
  const ref = loadLockedReference(speaker === 'bull' ? 'affirmative' : 'negative');
  return { url: ref.url, prompt: commentatorPrompt(line, shot) };
}

/**
 * One-off scenes: b-roll and vox pops, pure text-to-video with no reference.
 * These faces and places never recur, so consistency is not a constraint —
 * which is exactly what makes the field formats infinitely varied. Prompts
 * force fictional people and generic, unbranded places: the channel covers
 * real claims, but it never fabricates footage of real entities.
 */
export async function generateSceneClip(
  scene: string,
  opts: { dialogue?: string; seconds?: number } = {},
): Promise<AnchorClip> {
  const seconds = Math.min(15, Math.max(4, opts.seconds ?? 10));
  const started = Date.now();
  const prompt = opts.dialogue
    ? `${scene}. The person speaks directly to an off-camera interviewer, natural and unpolished, with accurate lip sync: "${opts.dialogue}" Handheld news-camera framing, natural ambient sound. A fictional person — not a real or identifiable person. Generic unbranded location, no logos, no readable signage, no on-screen text or captions.`
    : `${scene}. Documentary news b-roll: natural motion, ambient sound only, absolutely no speech and no narration. Generic unbranded location — not a real or identifiable place, no logos, no readable signage, no identifiable people, no on-screen text or captions.`;
  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: ANCHOR_MODEL,
    prompt,
    duration: seconds,
  });
  const id = submitted.request_id ?? submitted.id;
  if (!id) throw new Error('no request_id for scene clip');
  const url = await pollVideo(id, 'scene clip');
  return { videoUrl: url, line: opts.dialogue ?? '', seconds, renderMs: Date.now() - started };
}

async function pollVideo(id: string, label: string, timeoutMs = 420_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    const p = await xai.get<{ status?: string; video?: { url?: string }; error?: unknown }>(`/videos/${id}`);
    const status = String(p.status ?? '').toLowerCase();
    if (['done', 'completed', 'succeeded'].includes(status)) {
      if (!p.video?.url) throw new Error(`${label} completed with no video url`);
      return p.video.url;
    }
    if (['failed', 'error'].includes(status)) {
      throw new Error(`${label} failed: ${JSON.stringify(p.error ?? p).slice(0, 180)}`);
    }
  }
  throw new Error(`${label} timed out`);
}

/**
 * Split copy for an extended take: the base generation speaks the front of
 * the line, the extension continues the rest. Cut at a sentence boundary
 * nearest the base's share of the words, so the seam lands on a breath.
 */
export function splitForExtension(line: string, baseShare: number): [string, string] {
  const sentences = line.match(/[^.!?]+[.!?]+["')\]]*\s*/g) ?? [line];
  if (sentences.length < 2) {
    const words = line.split(/\s+/);
    const cut = Math.max(1, Math.round(words.length * baseShare));
    return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
  }
  const total = line.length;
  let acc = '';
  for (let i = 0; i < sentences.length - 1; i++) {
    acc += sentences[i];
    if (acc.length / total >= baseShare * 0.8) {
      return [acc.trim(), sentences.slice(i + 1).join('').trim()];
    }
  }
  return [sentences.slice(0, -1).join('').trim(), sentences[sentences.length - 1]!.trim()];
}

/** Generate an on-camera beat for any speaker, optionally as an extended take. */
export async function generateSpeakerClip(
  speaker: Speaker,
  line: string,
  opts: { seconds?: number; shot?: Shot; extendSeconds?: number; desk?: boolean } = {},
): Promise<AnchorClip> {
  const baseSeconds = opts.seconds ?? ANCHOR_SECONDS;
  const extendSeconds = Math.max(0, Math.min(15, opts.extendSeconds ?? 0));
  const shot = opts.shot ?? 'medium';
  const started = Date.now();

  const [head, tail] =
    extendSeconds > 0 ? splitForExtension(line, baseSeconds / (baseSeconds + extendSeconds)) : [line, ''];

  const setup = opts.desk
    ? { url: loadDeskReference().url, prompt: deskPrompt(head, speaker, shot) }
    : speakerSetup(speaker, head, shot);
  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: ANCHOR_MODEL,
    image: { url: setup.url },
    prompt: setup.prompt,
    duration: baseSeconds,
  });
  const id = submitted.request_id ?? submitted.id;
  if (!id) throw new Error(`no request_id for ${speaker} clip`);
  const baseUrl = await pollVideo(id, `${speaker} clip`);

  if (!tail) return { videoUrl: baseUrl, line, seconds: baseSeconds, renderMs: Date.now() - started };

  // Extended take: continue the same shot with the rest of the copy. If the
  // extension fails, the base take still airs — a shorter beat, not a hole.
  try {
    const ext = await xai.post<{ request_id?: string; id?: string }>('/videos/extensions', {
      model: EXTEND_MODEL,
      video: { url: baseUrl },
      prompt: `The same speaker continues seamlessly, without pause or reset, delivering the next part of the same thought to camera with the same energy and accurate lip sync: "${tail}" Same framing, same set, same lighting. No on-screen text, no captions, no graphics.`,
      duration: extendSeconds,
    });
    const extId = ext.request_id ?? ext.id;
    if (!extId) throw new Error('no request_id for extension');
    const fullUrl = await pollVideo(extId, `${speaker} extension`);
    return { videoUrl: fullUrl, line, seconds: baseSeconds + extendSeconds, renderMs: Date.now() - started };
  } catch (err) {
    // The shorter base take airs instead — but say so, loudly, or a broken
    // extensions endpoint would masquerade as a stylistic choice.
    console.log(`[live] extension fell back to base take: ${err instanceof Error ? err.message : err}`);
    return { videoUrl: baseUrl, line, seconds: baseSeconds, renderMs: Date.now() - started };
  }
}

/**
 * The idle loop: the anchor holding the desk between segments.
 *
 * This is what keeps the channel from blanking between bulletins. Without it
 * the stage empties every time a clip ends and the anchor visibly disappears,
 * which no real broadcast does — the presenter is always on set, graphics ride
 * over and beside her.
 *
 * Generated once and cached to disk, because it is the same shot every time.
 */
export async function ensureIdleLoop(): Promise<string> {
  const out = resolve(process.cwd(), 'public/media/desk-idle.mp4');
  if (existsSync(out)) return '/live/media/desk-idle.mp4';
  // Cached loops still play with video off; only the render is suppressed.
  if (!config.videoEnabled) throw new Error('video generation is off (NEWS_VIDEO=1 to enable)');

  const ref = loadDeskReference();
  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: ANCHOR_MODEL,
    image: { url: ref.url },
    prompt:
      'The two news anchors hold the shared desk between segments while a report plays: she squares her notes, he glances toward the video wall then back, both with small natural posture shifts and blinks. Mouths closed, not speaking, no dialogue and no audio. Wide two-shot, camera locked off. Studio set and lighting unchanged.',
    duration: 8,
  });
  const id = submitted.request_id ?? submitted.id;
  if (!id) throw new Error('no request_id for idle loop');

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const p = await xai.get<{ status?: string; video?: { url?: string } }>(`/videos/${id}`);
    const status = String(p.status ?? '').toLowerCase();
    if (['done', 'completed', 'succeeded'].includes(status) && p.video?.url) {
      const bytes = Buffer.from(await (await fetch(p.video.url)).arrayBuffer());
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
      return '/live/media/desk-idle.mp4';
    }
    if (['failed', 'error'].includes(status)) throw new Error('idle loop generation failed');
  }
  throw new Error('idle loop timed out');
}
