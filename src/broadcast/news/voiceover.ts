import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AUDIO_DELTA, RealtimeSession, RESPONSE_DONE } from '../xai/realtime.js';
import type { Speaker } from './segments.js';

/**
 * Voice-over-graphics: narration with no talking head.
 *
 * This exists because of a large asymmetry in render cost. An anchor clip takes
 * ~20s to generate; audio alone takes ~6s over the realtime socket. Waiting on
 * video for every segment leaves long silent holes, which is what made the
 * channel feel dead between bulletins.
 *
 * So the channel narrates over live charts while the next on-camera clip
 * renders — which is also just what a markets channel does. The anchor is not
 * on screen for most of the airtime of a real one either.
 *
 * The realtime session is driven as a verbatim renderer: it speaks the line
 * back exactly, which was verified word for word.
 */

const OUT_DIR = resolve(process.cwd(), 'public/media');
/** Fixed per speaker — a commentator whose voice changes is not a character. */
const SPEAKER_VOICES: Record<Speaker, string> = {
  anchor: process.env.VO_VOICE ?? 'eve',
  cohost: 'sal',
  bull: 'ara',
  bear: 'leo',
  reporter: 'rex',
  // On camera her clip carries its own voice; this only backs rehearsal mode.
  weather: 'ara',
};

const INSTRUCTIONS =
  'You are a text-to-speech renderer. Speak the user message back VERBATIM as your spoken reply. Do not greet, acknowledge, summarise, or add any words of your own.';

/**
 * Loudness-normalise speech PCM to a broadcast bed.
 *
 * Measured: raw realtime-voice output sits near -21 LUFS while Grok Imagine
 * clip audio sits near -12 LUFS — a 9 dB jump between lanes that viewers hear
 * as the channel lurching. VO is normalised here to ≈ -16 dBFS RMS and the
 * player pulls clip audio down to the same target, so a beat handoff is level.
 */
function normalize(pcm: Buffer, targetDb = -16): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return pcm;
  let sumSq = 0;
  let peak = 1;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(sumSq / n) / 32768 || 1e-9);
  const gain = Math.min(10 ** ((targetDb - rmsDb) / 20), (0.98 * 32767) / peak);
  if (Math.abs(gain - 1) < 0.05) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * gain))), i * 2);
  }
  return out;
}

function wav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export type Voiceover = { audioPath: string; seconds: number; renderMs: number };

export async function renderVoiceover(line: string, id: string, speaker: Speaker = 'anchor'): Promise<Voiceover> {
  const started = Date.now();
  const s = new RealtimeSession();
  try {
    await s.connect();
    s.send({
      type: 'session.update',
      session: {
        voice: SPEAKER_VOICES[speaker],
        instructions: INSTRUCTIONS,
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24000 } },
          output: { format: { type: 'audio/pcm', rate: 24000 } },
        },
      },
    });
    await s.waitForType('session.updated', 10000).catch(() => undefined);
    s.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] },
    });
    s.send({ type: 'response.create' });
    await s.waitFor((e) => RESPONSE_DONE.test(e.type) || e.type === 'error', 40000, 'voiceover').catch(() => undefined);

    const pcm = Buffer.concat(s.eventsOfType(AUDIO_DELTA).map((e) => Buffer.from(String(e.delta ?? ''), 'base64')));
    if (pcm.length === 0) throw new Error('no audio returned');

    const file = `vo-${id}.wav`;
    const path = resolve(OUT_DIR, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, wav(normalize(pcm)));
    return { audioPath: `/live/media/${file}`, seconds: pcm.length / 48000, renderMs: Date.now() - started };
  } finally {
    s.close();
  }
}
