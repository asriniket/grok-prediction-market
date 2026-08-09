import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { launch, getStream, wss } from 'puppeteer-stream';

/**
 * The program encoder — the single feed everyone watches.
 *
 *   npm run encoder
 *
 * One headless Chrome opens the channel in program mode (?program=1: sound on,
 * no unmute overlay) and captures the tab — video AND page audio — via the
 * tabCapture extension puppeteer-stream injects. ffmpeg transcodes the webm
 * into H.264/AAC and fans it out:
 *
 *   - HLS under public/media/hls/, served at /live/media/hls/live.m3u8 and
 *     playable at /live/watch — every viewer sees the identical program feed.
 *   - Optionally RTMP(S): set RTMP_URL to a full ingest URL (X Media Studio
 *     Producer, or any RTMP endpoint) and the same feed goes there too.
 *     X's Producer requires Premium on the account; the moment a stream key
 *     exists this needs no code change.
 *
 * The page itself stays the renderer — WS-driven viewers remain in sync via
 * the shared program clock; this process just makes the feed portable.
 */

const PAGE = process.env.PROGRAM_URL ?? 'http://localhost:3000/live?program=1';
const RTMP = (process.env.RTMP_URL ?? '').trim();
const HLS_DIR = resolve(process.cwd(), 'public/media/hls');
const W = Number(process.env.ENCODER_WIDTH ?? 1280);
const H = Number(process.env.ENCODER_HEIGHT ?? 720);
const FPS = 30;

async function main() {
  rmSync(HLS_DIR, { recursive: true, force: true });
  mkdirSync(HLS_DIR, { recursive: true });

  const browser = await launch({
    // puppeteer-stream rides puppeteer-core, which needs an explicit binary —
    // use the Chrome that full puppeteer manages (or CHROME_PATH override).
    executablePath: process.env.CHROME_PATH ?? (await Promise.resolve(puppeteer.executablePath())),
    // tabCapture rides an extension; Chrome's new headless supports both.
    // ENCODER_HEADFUL=1 falls back to a visible window if capture misbehaves.
    headless: process.env.ENCODER_HEADFUL === '1' ? false : ('new' as never),
    defaultViewport: { width: W, height: H },
    args: [
      `--window-size=${W},${H + 88}`,
      '--autoplay-policy=no-user-gesture-required',
      '--hide-crash-restore-bubble',
    ],
  });

  const page = await browser.newPage();
  await page.goto(PAGE, { waitUntil: 'networkidle2', timeout: 60_000 });
  console.log(`[encoder] capturing ${PAGE} at ${W}x${H}`);

  const stream = await getStream(page, {
    audio: true,
    video: true,
    frameSize: 1000,
    videoConstraints: {
      mandatory: { minWidth: W, minHeight: H, maxWidth: W, maxHeight: H, maxFrameRate: FPS },
    } as never,
  });

  const tee = [
    `[f=hls:hls_time=4:hls_list_size=8:hls_flags=delete_segments+independent_segments]${resolve(HLS_DIR, 'live.m3u8')}`,
    RTMP ? `[f=flv:onfail=ignore]${RTMP}` : '',
  ]
    .filter(Boolean)
    .join('|');

  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'pipe:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-b:v', '3500k', '-maxrate', '3500k', '-bufsize', '7000k',
      '-r', String(FPS), '-g', String(FPS * 2),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-flags', '+global_header',
      '-map', '0:v', '-map', '0:a',
      '-f', 'tee', tee,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  console.log(`[encoder] ffmpeg up — HLS at /live/media/hls/live.m3u8${RTMP ? ' + RTMP ingest' : ' (no RTMP_URL set)'}`);

  stream.pipe(ff.stdin);

  const shutdown = async () => {
    console.log('\n[encoder] shutting down');
    try { stream.destroy(); } catch { /* already gone */ }
    try { ff.stdin.end(); } catch { /* already gone */ }
    try { await browser.close(); } catch { /* already gone */ }
    try { (await wss).close(); } catch { /* already gone */ }
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  ff.on('exit', (code) => {
    console.log(`[encoder] ffmpeg exited (${code}) — stopping`);
    void shutdown();
  });
}

main().catch((err) => {
  console.error('[encoder] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
