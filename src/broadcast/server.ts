import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { Engine } from './engine.js';
import { ensureIdleLoop } from './news/anchor.js';
import { NewsDirector, type NewsSegment } from './news/director.js';

/**
 * Threadline — the live channel.
 *
 *   npm run dev         # the market engine (port 3000)
 *   npm run broadcast   # this (port 8082)
 *
 * Reads the engine over its public API and SSE feed and never writes to the
 * book, which is the separation the service README asks for. The engine is the
 * source of truth; this is a renderer pointed at it.
 */

const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

async function main() {
  console.log(`\n${C.bold}THREADLINE LIVE — channel${C.reset}`);

  if (!existsSync(resolve(process.cwd(), 'assets/champions/anchor.jpg'))) {
    throw new Error('Anchor reference missing. Run: npm run champions:lock');
  }

  const engine = new Engine();
  const probe = await engine.markets();
  console.log(
    probe.length
      ? `${C.dim}engine: ${probe.length} contracts from ${config.engineUrl}${C.reset}`
      : `${C.dim}engine: no contracts at ${config.engineUrl} — start it with npm run dev${C.reset}`,
  );
  engine.connect((m) => console.log(`${C.dim}  ${m}${C.reset}`));

  process.stdout.write(`${C.dim}preparing idle loop… ${C.reset}`);
  let idleUrl: string | undefined;
  try {
    idleUrl = await ensureIdleLoop();
    console.log(`${C.dim}ready${C.reset}`);
  } catch (err) {
    console.log(`${C.dim}unavailable (${err instanceof Error ? err.message : err}) — holding on the still${C.reset}`);
  }

  let latest: Record<string, unknown> = { markets: probe, traders: engine.getTraders(), idleUrl };
  const clients = new Set<WebSocket>();

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    const file = url === '/' ? 'public/news.html' : url.startsWith('/assets/') ? url.slice(1) : `public${url}`;
    const path = resolve(process.cwd(), file);
    const roots = [resolve(process.cwd(), 'public'), resolve(process.cwd(), 'assets')];
    if (!roots.some((r) => path.startsWith(r)) || !existsSync(path)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(readFileSync(path));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(latest));
    ws.on('close', () => clients.delete(ws));
  });
  server.listen(config.broadcastPort);
  console.log(`${C.green}▸ channel: http://localhost:${config.broadcastPort}${C.reset}\n`);

  const push = (segment: NewsSegment) => {
    const markets = segment.kind === 'board' ? segment.markets : (latest.markets as unknown[]);
    latest = { segment, markets, traders: engine.getTraders(), idleUrl };
    const payload = JSON.stringify(latest);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(payload);
    if (segment.kind === 'beat') {
      const who = segment.speaker === 'anchor' ? 'MARA' : segment.speaker.toUpperCase();
      console.log(`${C.cyan}${segment.videoUrl ? 'ON CAMERA' : 'VO'}${C.reset} ${C.dim}[${who}]${C.reset} ${segment.line}`);
    }
  };

  const director = new NewsDirector({
    getMarkets: () => engine.markets(),
    getTraders: () => engine.getTraders(),
    getRecent: () => engine.getRecent(),
    takeSwing: () => engine.takeSwing(),
    onSegment: push,
    onLog: (m) => console.log(`${C.dim}  ${m}${C.reset}`),
    lookahead: Number(process.env.NEWS_LOOKAHEAD ?? 2),
  });

  const shutdown = () => {
    director.stop();
    engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await director.run();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
