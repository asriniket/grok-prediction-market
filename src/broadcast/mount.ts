import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import type { Express } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine } from './engine.js';
import { ensureIdleLoop } from './news/anchor.js';
import { NewsDirector, type NewsSegment } from './news/director.js';
import { CAST } from './news/segments.js';

/**
 * Mounts the live channel onto the app, so the whole product is one origin on
 * one port rather than a separate renderer the viewer has to know about.
 *
 *   GET /live         the channel
 *   WS  /live/ws      segment stream
 *
 * It still talks to the engine only through the public API and the SSE feed —
 * mounting is a deployment decision, not a coupling one. The renderer never
 * touches the store.
 */

export type MountOptions = {
  app: Express;
  server: Server;
  /** Where the engine's own API is reachable. */
  engineUrl: string;
  log?: (m: string) => void;
};

export function mountBroadcast({ app, server, engineUrl, log = () => {} }: MountOptions): { stop: () => void } {
  const engine = new Engine(engineUrl);
  const clients = new Set<WebSocket>();
  let latest: Record<string, unknown> = { markets: [], traders: [] };

  // --- static: the page and its media ---
  app.get('/live', (_req, res) => {
    const path = resolve(process.cwd(), 'public/news.html');
    if (!existsSync(path)) {
      res.status(404).type('text/plain').send('public/news.html not found');
      return;
    }
    res.type('text/html; charset=utf-8').send(readFileSync(path, 'utf8'));
  });

  // sendFile rather than a buffered send: it answers Range requests, which
  // seeking into a clip (the late-join case) and Safari's video stack require.
  app.get(/^\/live\/(media|assets)\/.+/, (req, res) => {
    const rel = req.path.replace(/^\/live\//, '');
    const root = rel.startsWith('assets/') ? process.cwd() : resolve(process.cwd(), 'public');
    const path = resolve(root, rel);
    const allowed = [resolve(process.cwd(), 'public'), resolve(process.cwd(), 'assets')];
    if (!allowed.some((r) => path.startsWith(r)) || !existsSync(path)) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.sendFile(path);
  });

  // --- clip localisation ---
  // Generated clips come back on ephemeral third-party URLs with unknown CORS.
  // Each one is pulled to disk the moment it exists and every viewer-facing
  // payload carries the local path instead, so preloading, seeking and any
  // downstream encoder all work against one origin that never expires.
  const clipDir = resolve(process.cwd(), 'public/media/clips');
  mkdirSync(clipDir, { recursive: true });
  const clipIds = new Map<string, string>(); // remote url -> id
  const clipDownloads = new Map<string, Promise<string>>(); // id -> local path
  let clipSeq = 0;

  const localizeClip = (url?: string): string | undefined => {
    if (!url || !/^https?:\/\//.test(url)) return url;
    const known = clipIds.get(url);
    if (known) return `/live/clip/${known}`;
    const id = `c${++clipSeq}`;
    clipIds.set(url, id);
    const path = resolve(clipDir, `${id}.mp4`);
    clipDownloads.set(
      id,
      (async () => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`clip fetch HTTP ${r.status}`);
        writeFileSync(path, Buffer.from(await r.arrayBuffer()));
        return path;
      })().catch((err) => {
        log(`clip ${id} download failed: ${err instanceof Error ? err.message : err}`);
        throw err;
      }),
    );
    return `/live/clip/${id}`;
  };

  app.get('/live/clip/:id', async (req, res) => {
    const id = String(req.params.id).replace(/[^a-z0-9]/gi, '');
    const download = clipDownloads.get(id);
    if (!download) {
      res.status(404).type('text/plain').send('unknown clip');
      return;
    }
    try {
      res.sendFile(await download);
    } catch {
      // Download failed — fall back to the source URL and let the player try.
      const remote = [...clipIds.entries()].find(([, v]) => v === id)?.[0];
      if (remote) res.redirect(remote);
      else res.status(502).type('text/plain').send('clip unavailable');
    }
  });

  // --- the simulcast player ---
  // When the encoder is running, /live/watch plays its HLS output: one
  // pre-mixed program feed, byte-identical for every viewer, and the same
  // stream that an RTMP target (e.g. X) receives.
  app.get('/live/watch', (_req, res) => {
    res.type('text/html; charset=utf-8').send(`<!doctype html><html><head><meta charset="utf-8"/>
<title>Threadline — Simulcast</title>
<style>body{margin:0;background:#0d0d0d;color:#f5f1e8;font-family:Inter,system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px}
video{width:min(100vw,177.8vh);max-height:100vh;background:#000}
.off{font-size:14px;color:#a59f98}</style></head><body>
<video id="v" controls autoplay playsinline></video><div class="off" id="s"></div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script>
const src='/live/media/hls/live.m3u8',v=document.getElementById('v'),s=document.getElementById('s');
function boot(){
  if(v.canPlayType('application/vnd.apple.mpegurl')){v.src=src;return;}
  if(window.Hls&&Hls.isSupported()){const h=new Hls({liveSyncDurationCount:3});h.loadSource(src);h.attachMedia(v);
    h.on(Hls.Events.ERROR,(e,d)=>{if(d.fatal){s.textContent='Feed offline — start the encoder (npm run encoder). Retrying…';setTimeout(()=>{h.destroy();boot()},5000)}});}
}
boot();
</script></body></html>`);
  });

  // --- the segment stream ---
  // Every payload carries serverNow, so clients can convert the segment's `at`
  // into a position on THEIR clock and seek into media accordingly. That is
  // what makes the channel one shared timeline instead of a per-viewer replay:
  // a viewer joining mid-beat lands mid-beat, exactly like turning on a TV.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/live/ws')) return; // leave other upgrades alone
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ ...latest, serverNow: Date.now(), joined: true, watching: clients.size }));
      ws.on('close', () => clients.delete(ws));
    });
  });

  const push = (raw: NewsSegment) => {
    const segment =
      'videoUrl' in raw && raw.videoUrl ? { ...raw, videoUrl: localizeClip(raw.videoUrl) } : raw;
    // Preloads are forwarded but never stored: they are cache hints, not the
    // state of air, and a late joiner must receive what is AIRING.
    if (segment.kind === 'preload') {
      const hint = JSON.stringify({ preload: segment, serverNow: Date.now() });
      for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(hint);
      return;
    }
    const markets = segment.kind === 'board' ? segment.markets : (latest.markets as unknown[]);
    latest = { ...latest, segment, markets, traders: engine.getTraders(), recent: engine.getRecent().slice(-6) };
    const payload = JSON.stringify({ ...latest, serverNow: Date.now(), watching: clients.size });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
    if (segment.kind === 'beat') {
      const who = CAST[segment.speaker as keyof typeof CAST]?.name ?? segment.speaker.toUpperCase();
      log(`${segment.videoUrl ? 'ON CAMERA' : 'VO'} [${who}] ${segment.line}`);
    }
  };

  const director = new NewsDirector({
    getMarkets: () => engine.markets(),
    getTraders: () => engine.getTraders(),
    getRecent: () => engine.getRecent(),
    takeSwing: () => engine.takeSwing(),
    takeNewListing: () => engine.takeNewListing(),
    onSegment: push,
    onLog: log,
    lookahead: Number(process.env.NEWS_LOOKAHEAD ?? 2),
  });

  // Listings must never be missed: poll as a second detection path alongside
  // the SSE stream. Ten seconds is faster than any presenter needs.
  const listingWatch = setInterval(() => void engine.pollListings().catch(() => {}), 10_000);

  void (async () => {
    engine.connect(log);
    await engine.pollListings().catch(() => {});
    await engine.loadRoster().catch(() => log('roster unavailable — karma segments wait for live trades'));
    latest = { ...latest, markets: await engine.markets(), traders: engine.getTraders() };
    try {
      latest = { ...latest, idleUrl: await ensureIdleLoop() };
      log('idle loop ready');
    } catch (err) {
      log(`idle loop unavailable (${err instanceof Error ? err.message : err}) — holding on the still`);
    }
    await director.run();
  })();

  return {
    stop: () => {
      clearInterval(listingWatch);
      director.stop();
      engine.close();
      for (const ws of clients) ws.close();
    },
  };
}
