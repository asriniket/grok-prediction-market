import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { xai } from '../xai/rest.js';
import { loadAnchorReference, loadLockedReference } from '../champions/generate.js';
import type { Speaker } from './segments.js';

/**
 * Anchor clip generation.
 *
 * Grok Imagine 1.5 produces native synchronised audio — including lip-synced
 * dialogue — in the SAME pass as the video. Verified: generated clips carry
 * both a video track and an mp4a/esds audio track.
 *
 * This replaces the earlier split architecture (silent video + separate TTS
 * over the realtime socket). That approach could never lip-sync, because the
 * video generator never saw the words. Putting the line in the prompt is the
 * whole fix.
 */

export const ANCHOR_MODEL = process.env.ANCHOR_MODEL ?? 'grok-imagine-video-1.5';

/**
 * Clip length. Grok Imagine tops out at 15s.
 *
 * Longer is more airtime per render AND better pacing — fewer cuts back to
 * graphics. Render time scales roughly with duration, so the generate-to-play
 * ratio stays about the same; what changes is that each expensive render buys
 * proportionally more screen time. Cost scales linearly, so this is the main
 * spend dial on the channel.
 */
export const ANCHOR_SECONDS = Math.min(15, Math.max(4, Number(process.env.ANCHOR_SECONDS ?? 12)));

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
 * Delivery direction is fixed across every bulletin so the anchor reads as one
 * consistent presenter rather than a different performance each time.
 */
function anchorPrompt(line: string): string {
  return `The news anchor sits at the news desk facing camera and delivers this line clearly and naturally, with accurate lip sync: "${line}" Locked-off camera, no zoom. The studio background and lighting stay exactly as they are. Calm authoritative broadcast delivery, minimal gesture. No on-screen text, no captions, no graphics, no lower thirds.`;
}

/** Commentators sit for a remote hit, not at the anchor desk. */
function commentatorPrompt(line: string): string {
  return `The commentator looks directly at camera and delivers this line naturally, with accurate lip sync: "${line}" Locked-off camera, no zoom. Background and lighting stay exactly as they are. Measured, engaged delivery, minimal gesture. No on-screen text, no captions, no graphics.`;
}

/** Reference and direction for whichever speaker has the beat. */
function speakerSetup(speaker: Speaker, line: string): { url: string; prompt: string } {
  if (speaker === 'anchor') return { url: anchorReference().url, prompt: anchorPrompt(line) };
  const ref = loadLockedReference(speaker === 'vera' ? 'affirmative' : 'negative');
  return { url: ref.url, prompt: commentatorPrompt(line) };
}

/** Generate an on-camera beat for any speaker. */
export async function generateSpeakerClip(
  speaker: Speaker,
  line: string,
  seconds = ANCHOR_SECONDS,
): Promise<AnchorClip> {
  const started = Date.now();
  const setup = speakerSetup(speaker, line);
  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: ANCHOR_MODEL,
    image: { url: setup.url },
    prompt: setup.prompt,
    duration: seconds,
  });
  const id = submitted.request_id ?? submitted.id;
  if (!id) throw new Error(`no request_id for ${speaker} clip`);

  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const p = await xai.get<{ status?: string; video?: { url?: string }; error?: unknown }>(`/videos/${id}`);
    const status = String(p.status ?? '').toLowerCase();
    if (['done', 'completed', 'succeeded'].includes(status)) {
      if (!p.video?.url) throw new Error('completed with no video url');
      return { videoUrl: p.video.url, line, seconds, renderMs: Date.now() - started };
    }
    if (['failed', 'error'].includes(status)) {
      throw new Error(`${speaker} clip failed: ${JSON.stringify(p.error ?? p).slice(0, 180)}`);
    }
  }
  throw new Error(`${speaker} clip timed out`);
}

/**
 * The idle loop: the anchor listening at the desk, saying nothing.
 *
 * This is what keeps the channel from blanking between bulletins. Without it
 * the stage empties every time a clip ends and the anchor visibly disappears,
 * which no real broadcast does — the presenter is always on set, graphics ride
 * over and beside her.
 *
 * Generated once and cached to disk, because it is the same shot every time.
 */
export async function ensureIdleLoop(): Promise<string> {
  const out = resolve(process.cwd(), 'public/media/anchor-idle.mp4');
  if (existsSync(out)) return '/live/media/anchor-idle.mp4';

  const ref = anchorReference();
  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: ANCHOR_MODEL,
    image: { url: ref.url },
    prompt:
      'The news anchor sits at the news desk listening attentively between segments. Mouth closed, not speaking, no dialogue and no audio. Small natural movements only: slow blinking, a slight shift of posture, minimal head motion. Locked-off camera, no zoom. Studio background and lighting unchanged.',
    duration: 6,
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
      return '/live/media/anchor-idle.mp4';
    }
    if (['failed', 'error'].includes(status)) throw new Error('idle loop generation failed');
  }
  throw new Error('idle loop timed out');
}

export async function generateAnchorClip(line: string, seconds = ANCHOR_SECONDS): Promise<AnchorClip> {
  const started = Date.now();
  const ref = anchorReference();

  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: ANCHOR_MODEL,
    image: { url: ref.url },
    prompt: anchorPrompt(line),
    duration: seconds,
  });
  const id = submitted.request_id ?? submitted.id;
  if (!id) throw new Error('no request_id for anchor clip');

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const p = await xai.get<{ status?: string; video?: { url?: string }; error?: unknown }>(`/videos/${id}`);
    const status = String(p.status ?? '').toLowerCase();
    if (['done', 'completed', 'succeeded'].includes(status)) {
      if (!p.video?.url) throw new Error('completed with no video url');
      return { videoUrl: p.video.url, line, seconds, renderMs: Date.now() - started };
    }
    if (['failed', 'error'].includes(status)) {
      throw new Error(`anchor clip failed: ${JSON.stringify(p.error ?? p).slice(0, 180)}`);
    }
  }
  throw new Error('anchor clip timed out');
}
