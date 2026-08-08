import WebSocket from 'ws';
import { config, requireXaiKey } from '../config.js';

export type RealtimeEvent = Record<string, any> & { type: string };

export type RealtimeOptions = {
  model?: string;
  /** Extra query params, e.g. { conversation_id } for session resumption. */
  query?: Record<string, string>;
  /** Milliseconds to wait for the socket to open. */
  openTimeoutMs?: number;
};

/**
 * Thin wrapper over the xAI speech-to-speech WebSocket
 * (wss://api.x.ai/v1/realtime — OpenAI Realtime-compatible wire format).
 *
 * Records every inbound event so probes can assert on the full transcript of
 * the session rather than racing a single listener.
 */
export class RealtimeSession {
  readonly events: RealtimeEvent[] = [];
  readonly binaryFrames: Buffer[] = [];
  private ws?: WebSocket;
  private waiters: Array<{ match: (e: RealtimeEvent) => boolean; resolve: (e: RealtimeEvent) => void }> = [];
  private subscribers: Array<(e: RealtimeEvent) => void> = [];
  private closeHandlers: Array<(info: { code: number; reason: string }) => void> = [];
  private closed?: { code: number; reason: string };

  constructor(private readonly opts: RealtimeOptions = {}) {}

  get closeInfo() {
    return this.closed;
  }

  async connect(): Promise<void> {
    const url = new URL(config.realtimeUrl);
    url.searchParams.set('model', this.opts.model ?? config.voiceModel);
    for (const [k, v] of Object.entries(this.opts.query ?? {})) url.searchParams.set(k, v);

    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${requireXaiKey()}` },
    });
    this.ws = ws;

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        this.binaryFrames.push(Buffer.from(data as Buffer));
        return;
      }
      let evt: RealtimeEvent;
      try {
        evt = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.events.push(evt);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(evt)) return true;
        w.resolve(evt);
        return false;
      });
      for (const cb of this.subscribers) cb(evt);
    });

    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const cb of this.closeHandlers) cb(this.closed);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`realtime socket did not open within ${this.opts.openTimeoutMs ?? 15000}ms`)),
        this.opts.openTimeoutMs ?? 15000,
      );
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          reject(
            new Error(
              `realtime handshake rejected: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString().slice(0, 400)}`,
            ),
          ),
        );
      });
    });
  }

  /** Subscribe to every inbound event. Returns an unsubscribe function. */
  onEvent(cb: (e: RealtimeEvent) => void): () => void {
    this.subscribers.push(cb);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== cb);
    };
  }

  onClose(cb: (info: { code: number; reason: string }) => void): void {
    this.closeHandlers.push(cb);
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(event: RealtimeEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('realtime socket is not open');
    }
    this.ws.send(JSON.stringify(event));
  }

  /** Resolve when an event matching `match` arrives — including one already seen. */
  waitFor(match: (e: RealtimeEvent) => boolean, timeoutMs = 20000, label = 'event'): Promise<RealtimeEvent> {
    const already = this.events.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}. Saw: ${this.seenTypes().join(', ') || '(nothing)'}`));
      }, timeoutMs);
      const wrapped = (e: RealtimeEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ match, resolve: wrapped });
    });
  }

  waitForType(type: string | RegExp, timeoutMs = 20000): Promise<RealtimeEvent> {
    const match = (e: RealtimeEvent) => (typeof type === 'string' ? e.type === type : type.test(e.type));
    return this.waitFor(match, timeoutMs, String(type));
  }

  /** Distinct event types seen so far, in first-seen order — handy in failure messages. */
  seenTypes(): string[] {
    return [...new Set(this.events.map((e) => e.type))];
  }

  eventsOfType(type: string | RegExp): RealtimeEvent[] {
    return this.events.filter((e) => (typeof type === 'string' ? e.type === type : type.test(e.type)));
  }

  /** First `error` event, if the server sent one. */
  firstError(): RealtimeEvent | undefined {
    return this.events.find((e) => e.type === 'error');
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Name a tool from either the flat shape we send (`{type:'function', name}`)
 * or the nested shape the server echoes back (`{type:'function', function:{name}}`).
 * Server-side tools echo as bare `{type:'x_search'}` and are named by type.
 */
export function toolName(tool: any): string {
  return tool?.function?.name ?? tool?.name ?? tool?.type ?? '(unknown)';
}

/** Matches both the GA (`response.output_audio.delta`) and beta (`response.audio.delta`) names. */
export const AUDIO_DELTA = /^response\.(output_)?audio\.delta$/;
export const AUDIO_TRANSCRIPT_DELTA = /^response\.(output_)?audio_transcript\.delta$/;
export const RESPONSE_DONE = /^response\.(done|completed)$/;
