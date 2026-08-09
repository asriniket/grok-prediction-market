import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { xai } from '../xai/rest.js';
import { anchorReferencePrompt, cohostReferencePrompt, loopPrompt, referencePrompt, reporterReferencePrompt, type Side } from './scaffold.js';

/**
 * Champion asset generation.
 *
 * Reference images are generated once and LOCKED — regenerating mid-build
 * causes character drift and collapses the consistency claim. Loops are then
 * conditioned on the locked reference so the same face recurs across every
 * market the system creates.
 *
 * Verified API shapes (the published docs were wrong on the second one):
 *   images : POST /images/generations  -> { data: [{ url, mime_type }] }
 *   video  : POST /videos/generations  with a TOP-LEVEL `image: { url }`.
 *            The documented `prompt: { image, text }` object returns HTTP 422
 *            "invalid type: map, expected a string".
 */

export const IMAGE_MODEL = process.env.IMAGE_MODEL ?? 'grok-imagine-image';
export const VIDEO_MODEL = process.env.VIDEO_MODEL ?? 'grok-imagine-video-1.5';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ChampionReference = { side: Side; url: string; prompt: string };
export type ChampionLoop = { side: Side; videoUrl: string; referenceUrl: string; prompt: string; elapsedMs: number };

export async function generateReference(side: Side): Promise<ChampionReference> {
  const prompt = referencePrompt(side);
  const res = await xai.post<{ data?: Array<{ url?: string }> }>('/images/generations', {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: 'url',
  });
  const url = res.data?.[0]?.url;
  if (!url) throw new Error(`no image URL returned for ${side}`);
  return { side, url, prompt };
}

/**
 * Load a champion's LOCKED reference from disk as a data URI.
 *
 * Generated image URLs live under an ephemeral `xai-tmp-imgen` path, so the
 * lock stores bytes rather than a link. Verified that `image.url` accepts a
 * `data:image/jpeg;base64,…` URI, which means the locked portrait can drive
 * generation with no hosting step and no drift.
 */
export function loadLockedReference(side: Side): ChampionReference {
  // Files are named by SIDE, not by character name — on-air names can change
  // without touching locked assets.
  const path = resolve(process.cwd(), `assets/champions/${side}.jpg`);
  const bytes = readFileSync(path);
  return {
    side,
    url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    prompt: referencePrompt(side),
  };
}

/** The anchor's locked portrait. Separate character, separate template. */
export async function generateAnchorReference(): Promise<ChampionReference> {
  const prompt = anchorReferencePrompt();
  const res = await xai.post<{ data?: Array<{ url?: string }> }>('/images/generations', {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: 'url',
  });
  const url = res.data?.[0]?.url;
  if (!url) throw new Error('no image URL returned for anchor');
  return { side: 'affirmative', url, prompt };
}

export function loadAnchorReference(): { url: string; prompt: string } {
  const path = resolve(process.cwd(), 'assets/champions/anchor.jpg');
  const bytes = readFileSync(path);
  return { url: `data:image/jpeg;base64,${bytes.toString('base64')}`, prompt: anchorReferencePrompt() };
}

/** The floor reporter's locked portrait. Fourth chair, own template. */
export async function generateReporterReference(): Promise<{ url: string; prompt: string }> {
  const prompt = reporterReferencePrompt();
  const res = await xai.post<{ data?: Array<{ url?: string }> }>('/images/generations', {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: 'url',
  });
  const url = res.data?.[0]?.url;
  if (!url) throw new Error('no image URL returned for reporter');
  return { url, prompt };
}

export function loadReporterReference(): { url: string; prompt: string } {
  const path = resolve(process.cwd(), 'assets/champions/reporter.jpg');
  const bytes = readFileSync(path);
  return { url: `data:image/jpeg;base64,${bytes.toString('base64')}`, prompt: reporterReferencePrompt() };
}

/** The co-anchor's locked portrait — second chair at the desk. */
export async function generateCohostReference(): Promise<{ url: string; prompt: string }> {
  const prompt = cohostReferencePrompt();
  const res = await xai.post<{ data?: Array<{ url?: string }> }>('/images/generations', {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: 'url',
  });
  const url = res.data?.[0]?.url;
  if (!url) throw new Error('no image URL returned for cohost');
  return { url, prompt };
}

export function loadCohostReference(): { url: string; prompt: string } {
  const path = resolve(process.cwd(), 'assets/champions/cohost.jpg');
  const bytes = readFileSync(path);
  return { url: `data:image/jpeg;base64,${bytes.toString('base64')}`, prompt: cohostReferencePrompt() };
}

/** The market meteorologist's locked portrait at her forecast wall. */
export function loadWeatherReference(): { url: string } {
  const path = resolve(process.cwd(), 'assets/champions/weather.jpg');
  const bytes = readFileSync(path);
  return { url: `data:image/jpeg;base64,${bytes.toString('base64')}` };
}

/**
 * The desk two-shot: both anchors at one table, composed from the two locked
 * singles via multi-image editing (POST /images/edits, `images: [...]` — the
 * documented single-`image` field rejects arrays). Mara sits frame-LEFT,
 * Derek frame-RIGHT; video direction depends on that layout.
 */
export function loadDeskReference(): { url: string } {
  const path = resolve(process.cwd(), 'assets/champions/desk.jpg');
  const bytes = readFileSync(path);
  return { url: `data:image/jpeg;base64,${bytes.toString('base64')}` };
}

async function pollVideo(requestId: string, timeoutMs = 300_000): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(5000);
    const p = await xai.get<{ status?: string; video?: { url?: string }; error?: unknown }>(`/videos/${requestId}`);
    const status = String(p.status ?? '').toLowerCase();
    if (['done', 'completed', 'succeeded'].includes(status)) {
      if (!p.video?.url) throw new Error('completed with no video URL');
      return p.video.url;
    }
    if (['failed', 'error'].includes(status)) {
      throw new Error(`video generation failed: ${JSON.stringify(p.error ?? p).slice(0, 200)}`);
    }
  }
  throw new Error(`video generation timed out after ${timeoutMs}ms`);
}

/** Generate a speaking loop conditioned on the champion's locked reference. */
export async function generateLoop(ref: ChampionReference, durationSec = 5): Promise<ChampionLoop> {
  const started = Date.now();
  const prompt = loopPrompt(ref.side);
  const submitted = await xai.post<{ request_id?: string; id?: string }>('/videos/generations', {
    model: VIDEO_MODEL,
    image: { url: ref.url },
    prompt,
    duration: durationSec,
  });
  const id = submitted.request_id ?? submitted.id;
  if (!id) throw new Error(`no request_id for ${ref.side} loop`);
  const videoUrl = await pollVideo(id);
  return { side: ref.side, videoUrl, referenceUrl: ref.url, prompt, elapsedMs: Date.now() - started };
}
