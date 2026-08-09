import { loadConfig } from '../config.js';

/**
 * Broadcast-side config, adapted from the app's AppConfig.
 *
 * The video layer is deliberately a separate subsystem — the service README is
 * explicit that video lives outside it and consumes events. So this reads the
 * app's configuration rather than introducing a second one, and only adds the
 * keys the renderer needs that the market engine has no opinion about
 * (realtime socket, voice model).
 */

const app = loadConfig();

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const config = {
  xaiApiKey: app.xaiApiKey ?? '',
  apiBase: opt('XAI_API_BASE', 'https://api.x.ai/v1'),
  realtimeUrl: opt('XAI_REALTIME_URL', 'wss://api.x.ai/v1/realtime'),
  voiceModel: opt('XAI_VOICE_MODEL', 'grok-voice-latest'),
  /** Same model the claim extractor uses, unless overridden for the renderer. */
  textModel: opt('XAI_TEXT_MODEL', app.xaiModel),
  /** Where the market engine is serving its API and SSE feed. */
  engineUrl: opt('ENGINE_URL', app.appUrl),
  /** Port the channel itself listens on. Not the engine's port. */
  broadcastPort: Number(opt('BROADCAST_PORT', '8082')),
  /**
   * On-camera clip generation. On by default — presenters on camera are what
   * makes the channel read as television rather than a narrated dashboard.
   * Every clip is a paid video render, so NEWS_VIDEO=0 remains available as
   * the spend kill-switch for voice-over-only rehearsal runs.
   */
  videoEnabled: opt('NEWS_VIDEO', '1') === '1',
} as const;

export function requireXaiKey(): string {
  if (!config.xaiApiKey) {
    throw new Error('XAI_API_KEY is not configured — the broadcast renderer needs it.');
  }
  return config.xaiApiKey;
}

export function redact(secret: string): string {
  if (!secret) return '(unset)';
  if (secret.length <= 12) return `${secret.slice(0, 3)}…`;
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}
