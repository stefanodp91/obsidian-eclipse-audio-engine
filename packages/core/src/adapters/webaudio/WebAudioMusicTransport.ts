// Music through Web Audio: one decoded buffer, one looping source.
//
// This is the transport with the fewest surprises. `AudioBufferSourceNode`
// loops at the sample, and `decodeAudioData` applies the encoder delay and
// padding an AAC file carries, so the seam a track was authored to have is the
// seam the player hears. Everything a platform player has to be *asked* to do
// correctly, this one does by construction.
//
// What it costs is memory and a little CPU, and the numbers are worth writing
// down rather than guessing at: a decoded buffer is float32 per channel at the
// context's rate, so 48 s of stereo at 48 kHz is ~18 MB and a 91 s menu loop is
// ~35 MB. One track at a time is therefore not an optimisation, it is the
// contract — with one exception that lasts a crossfade: a change on the beat
// keeps the outgoing track alive until its fade has finished.

import type { AssetPath, AudioErrorSink, MusicTransport, TrackId } from '../../ports/driven';
import type { WebAudioGraph } from './WebAudioGraph';
import { releaseStoppedSource } from './releaseStoppedSource';

/** How far ahead of the audio clock a start must be placed to land where it
 *  was placed. `currentTime` advances in render quanta, and on some platforms
 *  in larger steps: a start scheduled a few milliseconds ahead can already be
 *  in the past by the time the graph sees it, and Web Audio then starts it
 *  late — at the requested offset, so off the beat by exactly the delay. A
 *  boundary closer than this is skipped for the next one. */
const MIN_LEAD_S = 0.05;

/** The handover gain's automation, as data: `v0` until `t0`, a straight line
 *  to `v1` at `t1`, then `v1`. Kept so it can be replayed exactly when a
 *  second change cuts into a fade that is still running. */
interface Ramp {
    t0: number;
    v0: number;
    t1: number;
    v1: number;
}

interface Voice {
    id: TrackId;
    source: AudioBufferSourceNode;
    /** The handover: carries only the fades of a change on the beat, so they
     *  never fight `setVolume` and `fade`, which drive `gain`. Unity
     *  otherwise. */
    handover: GainNode;
    /** The level: volume, ducking and the ordinary crossfade. */
    gain: GainNode;
    /** Audio-clock time at which the source plays `offset`. */
    startAt: number;
    offset: number;
    loop: boolean;
    ramp: Ramp | null;
    /** Resolves once the voice has been stopped and taken apart. */
    ended: Promise<void>;
    markEnded: () => void;
}

const valueAt = (ramp: Ramp | null, t: number): number => {
    if (!ramp) return 1;
    if (t <= ramp.t0) return ramp.v0;
    if (t >= ramp.t1) return ramp.v1;
    return ramp.v0 + ((ramp.v1 - ramp.v0) * (t - ramp.t0)) / (ramp.t1 - ramp.t0);
};

/** `x mod m`, positive for a negative `x` too. */
const wrap = (x: number, m: number): number => ((x % m) + m) % m;

export class WebAudioMusicTransport implements MusicTransport {
    readonly kind = 'web-audio' as const;
    readonly gaplessLoop = true;

    private readonly buffers = new Map<TrackId, AudioBuffer>();
    private readonly loading = new Map<TrackId, Promise<AudioBuffer | null>>();
    private readonly voices = new Map<TrackId, Voice>();
    /** Voices handed over by a change on the beat: still fading out, no longer
     *  the track their id names. They stop themselves at the end of the fade. */
    private readonly retiring = new Set<Voice>();

    constructor(
        private readonly graph: WebAudioGraph,
        private readonly onError: AudioErrorSink,
        private readonly fetchAsset: (path: AssetPath) => Promise<ArrayBuffer>,
    ) {}

    async preload(id: TrackId, path: AssetPath): Promise<void> {
        await this.buffer(id, path);
    }

    async play(id: TrackId, options: { loop: boolean; volume: number }): Promise<void> {
        const ctx = this.graph.ensure();
        if (!ctx || !this.graph.musicBus) return;
        const buffer = this.buffers.get(id);
        if (!buffer) return; // never preloaded: silence, and the caller's error to make

        await this.stop(id);

        const voice = this.voice(ctx, this.graph.musicBus, id, buffer, options);
        voice.source.start(ctx.currentTime);
        this.voices.set(id, voice);
    }

    /** The change on the beat. Everything is scheduled on the audio clock in
     *  one turn — the start, both fades, the stop — so it lands on the sample
     *  however late the main thread runs, and stands still while the context is
     *  suspended. */
    async playAligned(
        id: TrackId,
        options: { after: TrackId; alignS: number; fadeMs: number; loop: boolean; volume: number },
    ): Promise<void> {
        const ctx = this.graph.ensure();
        const bus = this.graph.musicBus;
        if (!ctx || !bus) return;
        const buffer = this.buffers.get(id);
        if (!buffer || id === options.after) return;

        const outgoing = this.voices.get(options.after);
        const now = ctx.currentTime;
        const elapsed = outgoing ? outgoing.offset + (now - outgoing.startAt) : 0;
        const outBuffer = outgoing?.source.buffer;
        if (
            !outgoing ||
            !outBuffer ||
            !(options.alignS > 0 && Number.isFinite(options.alignS)) ||
            (!outgoing.loop && elapsed >= outBuffer.duration)
        ) {
            // Nothing to keep time with: start now, from zero.
            await this.play(id, options);
            return;
        }

        const fadeS = Math.max(0, options.fadeMs) / 1000;
        let at: number;
        let position: number;
        if (outgoing.startAt - now >= MIN_LEAD_S) {
            // `after` is itself a change still waiting for its instant: take its
            // place there. It never sounded, so it goes now; whatever it was
            // replacing keeps the fade it already has.
            at = outgoing.startAt;
            position = outgoing.offset;
            this.voices.delete(options.after);
            this.takeApart(outgoing);
        } else {
            ({ at, position } = this.nextBoundary(
                outgoing.startAt - outgoing.offset,
                now,
                outBuffer.duration,
                options.alignS,
            ));
            this.voices.delete(options.after);
            this.retiring.add(outgoing);
            this.fadeOutAt(outgoing, now, at, fadeS);
        }

        const previous = this.voices.get(id);
        if (previous) {
            this.voices.delete(id);
            this.takeApart(previous);
        }
        const voice = this.voice(ctx, bus, id, buffer, options);
        voice.startAt = at;
        voice.offset = wrap(position, buffer.duration);
        if (fadeS > 0) {
            voice.ramp = { t0: at, v0: 0, t1: at + fadeS, v1: 1 };
            const h = voice.handover.gain;
            h.value = 0;
            h.setValueAtTime(0, at);
            h.linearRampToValueAtTime(1, at + fadeS);
        }
        voice.source.start(at, voice.offset);
        this.voices.set(id, voice);

        await outgoing.ended;
    }

    async setVolume(id: TrackId, volume: number): Promise<void> {
        const ctx = this.graph.ctx;
        if (!ctx) return;
        const t = ctx.currentTime;
        for (const voice of this.voicesOf(id)) {
            voice.gain.gain.cancelScheduledValues(t);
            // A ramp and not an assignment: a step on a running signal is a click,
            // and the whole crossfade is built out of these.
            voice.gain.gain.setTargetAtTime(volume, t, 0.02);
        }
    }

    async fade(id: TrackId, to: number, ms: number): Promise<void> {
        const ctx = this.graph.ctx;
        if (!ctx) return;
        const t = ctx.currentTime;
        for (const voice of this.voicesOf(id)) {
            const gain = voice.gain.gain;
            gain.cancelScheduledValues(t);
            // The current value has to be pinned before the ramp, or `linearRamp`
            // interpolates from the last scheduled event rather than from where the
            // signal actually is.
            gain.setValueAtTime(gain.value, t);
            gain.linearRampToValueAtTime(to, t + Math.max(0.001, ms / 1000));
        }
    }

    async stop(id: TrackId): Promise<void> {
        const voice = this.voices.get(id);
        if (voice) {
            this.voices.delete(id);
            this.takeApart(voice);
        }
        for (const old of [...this.retiring]) if (old.id === id) this.takeApart(old);
    }

    async release(id: TrackId): Promise<void> {
        await this.stop(id);
        this.buffers.delete(id);
        this.loading.delete(id);
    }

    async dispose(): Promise<void> {
        for (const id of [...this.voices.keys()]) await this.stop(id);
        for (const old of [...this.retiring]) this.takeApart(old);
        this.buffers.clear();
        this.loading.clear();
    }

    /** The active voice of `id` and any of its own still fading out of a
     *  change: volume and fades are about the track, whichever voice is
     *  playing it. */
    private voicesOf(id: TrackId): Voice[] {
        const active = this.voices.get(id);
        const out = [...this.retiring].filter((v) => v.id === id);
        return active ? [active, ...out] : out;
    }

    private voice(
        ctx: AudioContext,
        bus: GainNode,
        id: TrackId,
        buffer: AudioBuffer,
        options: { loop: boolean; volume: number },
    ): Voice {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = options.loop;
        const handover = ctx.createGain();
        const gain = ctx.createGain();
        gain.gain.value = options.volume;
        source.connect(handover);
        handover.connect(gain);
        gain.connect(bus);
        let markEnded = () => {};
        const ended = new Promise<void>((resolve) => {
            markEnded = resolve;
        });
        const voice: Voice = {
            id,
            source,
            handover,
            gain,
            startAt: ctx.currentTime,
            offset: 0,
            loop: options.loop,
            ramp: null,
            ended,
            markEnded,
        };
        // A retiring voice ends on its own, on the audio clock; this is where
        // it is taken apart — after its end, not in the turn that stopped it.
        source.onended = () => {
            if (this.retiring.has(voice)) this.takeApart(voice);
        };
        return voice;
    }

    /** The next instant, at least `MIN_LEAD_S` ahead of `now`, at which a
     *  track crosses a multiple of `alignS` or its own loop seam — and the
     *  position it will be at then. `origin` is the audio-clock time at which
     *  the track was, or would have been, at position zero of its first turn;
     *  the instant is computed from it rather than by adding waits to `now`, so
     *  a line falls exactly where it should whenever the numbers allow it. */
    private nextBoundary(
        origin: number,
        now: number,
        duration: number,
        alignS: number,
    ): { at: number; position: number } {
        let turn = Math.floor((now - origin) / duration);
        let line = Math.floor((now - origin - turn * duration) / alignS) + 1;
        // Bounded so a grid finer than the lead cannot spin: it takes at most
        // `MIN_LEAD_S / alignS` lines to clear the lead, plus the seam.
        for (let step = 0; step < 100_000; step += 1) {
            let position = line * alignS;
            if (position >= duration) {
                turn += 1;
                line = 0;
                position = 0;
            }
            const at = origin + turn * duration + position;
            if (at - now >= MIN_LEAD_S) return { at, position };
            line += 1;
        }
        return { at: now + MIN_LEAD_S, position: wrap(now + MIN_LEAD_S - origin, duration) };
    }

    /** Schedules the outgoing voice's fade on its handover gain, from `at`,
     *  and its stop at the end of it. Its automation up to `at` is replayed
     *  as it was, so a fade-in still running from an earlier change carries
     *  on unchanged until the fade-out takes over. */
    private fadeOutAt(voice: Voice, now: number, at: number, fadeS: number): void {
        const h = voice.handover.gain;
        const ramp = voice.ramp;
        h.cancelScheduledValues(now);
        h.setValueAtTime(valueAt(ramp, now), now);
        if (ramp && ramp.t0 > now && ramp.t0 < at) h.setValueAtTime(ramp.v0, ramp.t0);
        if (ramp && ramp.t1 > now && ramp.t1 < at) h.linearRampToValueAtTime(ramp.v1, ramp.t1);
        const from = valueAt(ramp, at);
        h.linearRampToValueAtTime(from, at);
        if (fadeS > 0) h.linearRampToValueAtTime(0, at + fadeS);
        else h.setValueAtTime(0, at);
        voice.ramp = { t0: at, v0: from, t1: at + fadeS, v1: 0 };
        voice.source.stop(at + fadeS);
    }

    private takeApart(voice: Voice): void {
        this.retiring.delete(voice);
        try {
            voice.source.stop();
        } catch {
            /* already stopped */
        }
        releaseStoppedSource(voice.source);
        try {
            voice.source.disconnect();
            voice.handover.disconnect();
            voice.gain.disconnect();
        } catch {
            /* already detached */
        }
        voice.markEnded();
    }

    private buffer(id: TrackId, path: AssetPath): Promise<AudioBuffer | null> {
        const cached = this.buffers.get(id);
        if (cached) return Promise.resolve(cached);
        const inFlight = this.loading.get(id);
        if (inFlight) return inFlight;
        const ctx = this.graph.ensure();
        if (!ctx) return Promise.resolve(null);

        const flight = (async () => {
            try {
                const bytes = await this.fetchAsset(path);
                const decoded = await ctx.decodeAudioData(bytes);
                this.buffers.set(id, decoded);
                return decoded;
            } catch (error) {
                this.onError(error, { op: 'decode', id, path });
                return null;
            } finally {
                this.loading.delete(id);
            }
        })();
        this.loading.set(id, flight);
        return flight;
    }
}
