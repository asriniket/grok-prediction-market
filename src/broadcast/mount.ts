import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { extname, resolve } from 'node:path';
import type { Express } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine } from './engine.js';
import { ensureIdleLoop } from './news/anchor.js';
import { NewsDirector, type NewsSegment } from './news/director.js';

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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

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

  app.get(/^\/live\/(media|assets)\/.+/, (req, res) => {
    const rel = req.path.replace(/^\/live\//, '');
    const root = rel.startsWith('assets/') ? process.cwd() : resolve(process.cwd(), 'public');
    const path = resolve(root, rel);
    const allowed = [resolve(process.cwd(), 'public'), resolve(process.cwd(), 'assets')];
    if (!allowed.some((r) => path.startsWith(r)) || !existsSync(path)) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.type(MIME[extname(path)] ?? 'application/octet-stream').send(readFileSync(path));
  });

  // --- the segment stream ---
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/live/ws')) return; // leave other upgrades alone
    wss.handleUpgrade(request, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify(latest));
      ws.on('close', () => clients.delete(ws));
    });
  });

  const push = (segment: NewsSegment) => {
    const markets = segment.kind === 'board' ? segment.markets : (latest.markets as unknown[]);
    latest = { ...latest, segment, markets, traders: engine.getTraders() };
    const payload = JSON.stringify(latest);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
    if (segment.kind === 'beat') {
      const who = segment.speaker === 'anchor' ? 'MARA' : segment.speaker.toUpperCase();
      log(`${segment.videoUrl ? 'ON CAMERA' : 'VO'} [${who}] ${segment.line}`);
    }
  };

  const director = new NewsDirector({
    getMarkets: () => engine.markets(),
    getTraders: () => engine.getTraders(),
    getRecent: () => engine.getRecent(),
    takeSwing: () => engine.takeSwing(),
    onSegment: push,
    onLog: log,
    lookahead: Number(process.env.NEWS_LOOKAHEAD ?? 2),
  });

  void (async () => {
    engine.connect(log);
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
      director.stop();
      engine.close();
      for (const ws of clients) ws.close();
    },
  };
}
