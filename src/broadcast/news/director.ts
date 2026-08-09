import { ANCHOR_SECONDS, generateSceneClip, generateSpeakerClip, type Shot } from './anchor.js';
import { renderVoiceover } from './voiceover.js';
import { config } from '../config.js';
import { writeBeats, type Beat, type MarketLine, type TraderLine } from './bulletin.js';
import { RUNDOWN, SEGMENTS, type SegmentId } from './segments.js';

/**
 * Rolling news director.
 *
 * Works a RUNDOWN, not a loop. Each segment is written as beats, and each beat
 * is rendered by the lane its treatment implies:
 *
 *   ON CAMERA   speaker clip with native lip-synced audio   ~20s+ to render
 *   VOICE OVER  narration over the graphic, audio only      ~3-6s to render
 *
 * The open, the toss and the crossfire go on camera; the tape and the back
 * half work the graphics. That keeps video spend proportional to what it buys,
 * and matches how financial TV actually works — the presenter is off screen
 * for a lot of the airtime, but the segments that carry the show's identity
 * are carried by faces.
 */

export type NewsSegment =
  | { kind: 'beat'; at: number; line: string; speaker: string; treatment: string; kicker: string; segment: string; marketId?: string; videoUrl?: string; audioPath?: string; seconds: number; wire?: Array<{ source: string; text: string }>; strap?: string }
  | { kind: 'board'; at: number; markets: MarketLine[]; holdMs: number }
  | { kind: 'sting'; at: number; segment: string; badge: string; holdMs: number }
  | { kind: 'breaking'; at: number; line: string; marketId: string; from: number; to: number; audioPath?: string; seconds?: number }
  | { kind: 'preload'; at: number; videoUrl?: string; audioPath?: string };

export type NewsDirectorOptions = {
  getMarkets: () => Promise<MarketLine[]>;
  getTraders: () => TraderLine[];
  getRecent: () => string[];
  /** Consumes the next unreported swing. Drives breaking interrupts. */
  takeSwing?: () => { marketId: string; question: string; from: number; to: number } | undefined;
  onSegment: (s: NewsSegment) => void;
  onLog?: (m: string) => void;
  /** Segments prepared ahead of air. */
  lookahead?: number;
};

/**
 * The board is a real segment, not a screensaver — it gets held long enough
 * to actually read, the way a channel sits on the full board at the half hour.
 */
const BOARD_HOLD_MS = 12_000;
const STING_HOLD_MS = 2_200;
/**
 * Breaking is an interrupt, not a format. The book moves constantly — demo
 * flow alone can clear the swing threshold several times a minute — so
 * without a cooldown the channel degenerates into announcing breaking news
 * back to back forever. One interrupt, then the rundown gets the air back.
 */
const BREAKING_COOLDOWN_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Media = { videoUrl?: string; audioPath?: string; seconds: number };
type PreparedBeat = { beat: Beat; media: Promise<Media>; ready?: Media };
type PreparedSegment = { id: SegmentId; badge: string; beats: PreparedBeat[] };

export class NewsDirector {
  private stopped = false;
  private queue: PreparedSegment[] = [];
  private lastPrices = new Map<string, number>();
  private preparing = false;
  private said = new Set<string>();
  private seq = 0;
  private rot = 0;

  constructor(private readonly opts: NewsDirectorOptions) {}

  stop() {
    this.stopped = true;
  }

  private static norm(l: string): string {
    return l.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }

  private withDeltas(markets: MarketLine[]): MarketLine[] {
    return markets.map((m) => {
      const prev = this.lastPrices.get(m.id);
      return { ...m, delta: prev === undefined ? undefined : m.price - prev };
    });
  }

  /** Write the next segment in the rundown and start rendering its beats. */
  private async prepare(lookahead: number) {
    if (this.preparing || this.stopped || this.queue.length >= lookahead) return;
    this.preparing = true;
    const log = this.opts.onLog ?? (() => {});

    try {
      const id = RUNDOWN[this.rot % RUNDOWN.length]!;
      const next = RUNDOWN[(this.rot + 1) % RUNDOWN.length]!;
      this.rot++;

      // A trader profile with no traders is an empty board and a beat about
      // nothing — skip the slot and let the rotation move on.
      if (SEGMENTS[id].needsTraders && this.opts.getTraders().length === 0) {
        log(`${id}: no traders observed yet — skipped`);
        return;
      }

      const markets = this.withDeltas(await this.opts.getMarkets());
      const beats = await writeBeats(
        id,
        markets,
        this.opts.getTraders(),
        this.opts.getRecent(),
        [...this.said],
        id === 'tease' ? next : undefined,
      );
      // Baseline advances only when copy is written, so deltas measure movement
      // since the last segment rather than since the last poll.
      for (const m of markets) this.lastPrices.set(m.id, m.price);

      const fresh = beats.filter((b) => !this.said.has(NewsDirector.norm(b.line)));
      if (fresh.length === 0) {
        log(`${id}: nothing fresh`);
        return;
      }
      for (const b of fresh) {
        this.said.add(NewsDirector.norm(b.line));
        if (this.said.size > 250) this.said.delete(this.said.values().next().value!);
      }

      // With video off, an on-camera beat still airs — it just airs as
      // voice-over on the graphic rather than being dropped.
      const onCam = config.videoEnabled ? fresh.filter((b) => b.onCamera).length : 0;
      log(`prepared ${id} — ${fresh.length} beats (${config.videoEnabled ? `${onCam} on camera` : 'voice-over only'})`);

      // Consecutive takes of the same speaker alternate framing, so back-to-back
      // clips cut like a camera switch instead of jump-cutting.
      const takes = new Map<string, number>();
      // Marquee segments run takes longer than one render allows; the overflow
      // is produced as a seamless video extension of the base take.
      const extendSeconds = Math.max(0, (SEGMENTS[id].takeSeconds ?? ANCHOR_SECONDS) - ANCHOR_SECONDS);
      const lane = SEGMENTS[id].lane ?? 'studio';
      const prepared: PreparedBeat[] = fresh.map((beat) => {
        const take = takes.get(beat.speaker) ?? 0;
        takes.set(beat.speaker, take + 1);
        const shot: Shot = take % 2 === 0 ? 'medium' : 'close';
        const media: Promise<Media> =
          // PACKAGE: the reporter's voice track over generated b-roll — both
          // render in parallel; the track's length runs the beat and the
          // b-roll loops under it. If the pictures fail, the track still airs.
          lane === 'package'
            ? Promise.all([
                renderVoiceover(beat.line, `b${++this.seq}`, beat.speaker),
                beat.scene && config.videoEnabled
                  ? generateSceneClip(beat.scene, { seconds: 10 }).catch(() => undefined)
                  : Promise.resolve(undefined),
              ]).then(([vo, clip]) => ({ audioPath: vo.audioPath, videoUrl: clip?.videoUrl, seconds: vo.seconds }))
            // SCENE: a one-off character speaks the line in their own clip.
            : lane === 'scene' && beat.scene && config.videoEnabled
              ? generateSceneClip(beat.scene, { dialogue: beat.line, seconds: 10 }).then((c) => ({ videoUrl: c.videoUrl, seconds: c.seconds }))
              : beat.onCamera && config.videoEnabled
                ? generateSpeakerClip(beat.speaker, beat.line, {
                    shot,
                    extendSeconds,
                    // Anchors share one desk: their beats render from the
                    // two-shot so both hosts stay in frame together.
                    desk: SEGMENTS[id].deskShot === true && (beat.speaker === 'anchor' || beat.speaker === 'cohost'),
                  }).then((c) => ({ videoUrl: c.videoUrl, seconds: c.seconds }))
                : renderVoiceover(beat.line, `b${++this.seq}`, beat.speaker).then((v) => ({ audioPath: v.audioPath, seconds: v.seconds }));
        const pb: PreparedBeat = { beat, media };
        // As soon as a render lands, remember it and tell every viewer to warm
        // their cache — air time is not the moment to start a download.
        void media.then((m) => {
          pb.ready = m;
          this.opts.onSegment({ kind: 'preload', at: Date.now(), videoUrl: m.videoUrl, audioPath: m.audioPath });
        }).catch(() => {});
        return pb;
      });

      this.queue.push({ id, badge: SEGMENTS[id].badge, beats: prepared });
    } catch (err) {
      log(`prepare failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.preparing = false;
    }
  }

  /** Resolve if ready, without blocking air. */
  private static ready<T>(p: Promise<T>): Promise<T | undefined> {
    return Promise.race([p.catch(() => undefined), sleep(200).then(() => undefined)]);
  }

  private async airBoard() {
    this.opts.onSegment({
      kind: 'board',
      at: Date.now(),
      markets: this.withDeltas(await this.opts.getMarkets()),
      holdMs: BOARD_HOLD_MS,
    });
    await sleep(BOARD_HOLD_MS);
  }

  async run(): Promise<void> {
    const { onSegment } = this.opts;
    const log = this.opts.onLog ?? (() => {});
    const lookahead = this.opts.lookahead ?? 2;

    await this.airBoard();
    void this.prepare(lookahead);

    let lastBreaking = 0;
    while (!this.stopped) {
      void this.prepare(lookahead);

      // A real swing pre-empts the rundown. The interrupt is caused by the book
      // moving rather than by a timer, which is what makes it read as live —
      // but it airs at most once per cooldown, and everything queued behind it
      // is drained so the show can never get trapped announcing breaking news.
      const swing = this.opts.takeSwing?.();
      if (swing && Math.abs(swing.to - swing.from) >= 0.08 && Date.now() - lastBreaking >= BREAKING_COOLDOWN_MS) {
        lastBreaking = Date.now();
        while (this.opts.takeSwing?.()) { /* drain the backlog */ }
        const dir = swing.to > swing.from ? 'surged' : 'collapsed';
        const line = `We are going to interrupt the board, because ${swing.question.slice(0, 80)} just ${dir} ${Math.abs((swing.to - swing.from) * 100).toFixed(0)} points, and somebody out there is either very confident or very wrong.`;
        onSegment({ kind: 'breaking', at: Date.now(), line, marketId: swing.marketId, from: swing.from, to: swing.to });
        try {
          const vo = await renderVoiceover(line, `brk${++this.seq}`, 'anchor');
          onSegment({ kind: 'breaking', at: Date.now(), line, marketId: swing.marketId, from: swing.from, to: swing.to, audioPath: vo.audioPath, seconds: vo.seconds });
          await sleep(vo.seconds * 1000 + 500);
        } catch {
          await sleep(3000);
        }
        continue;
      }

      const seg = this.queue[0];
      if (!seg) {
        await this.airBoard();
        continue;
      }

      // Air only once the opening beat has rendered, so a segment never starts
      // and then stalls halfway through itself.
      const first = await NewsDirector.ready(seg.beats[0]!.media);
      if (!first) {
        await this.airBoard();
        continue;
      }
      this.queue.shift();

      onSegment({ kind: 'sting', at: Date.now(), segment: seg.id, badge: seg.badge, holdMs: STING_HOLD_MS });
      await sleep(STING_HOLD_MS);
      if (this.stopped) return;

      for (let i = 0; i < seg.beats.length; i++) {
        if (this.stopped) return;
        const { beat, media } = seg.beats[i]!;
        const m = i === 0 ? first : await media.catch(() => undefined);
        if (!m) {
          log(`beat dropped: ${beat.line.slice(0, 40)}…`);
          continue;
        }
        onSegment({
          kind: 'beat',
          at: Date.now(),
          line: beat.line,
          speaker: beat.speaker,
          treatment: beat.treatment,
          kicker: beat.kicker,
          segment: beat.segment,
          marketId: beat.marketId,
          videoUrl: m.videoUrl,
          audioPath: m.audioPath,
          seconds: m.seconds,
          wire: beat.wire,
          strap: beat.strap,
        });
        // Rapid segments cut hard; everything else gets a beat to breathe.
        await sleep(m.seconds * 1000 + (beat.treatment === 'rapid' ? 150 : 450));
      }
    }
  }
}
