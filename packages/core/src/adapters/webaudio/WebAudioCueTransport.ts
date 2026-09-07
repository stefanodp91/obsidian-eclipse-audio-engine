// Cues through Web Audio, on every platform.
//
// A cue is tens of milliseconds long and has to start on the frame the game
// asks for it. Crossing a native bridge to get hardware decoding for that is a
// bad trade: the round trip costs more than the decode saves, and it puts a
// promise between the tap and the sound.

import type { AssetPath, AudioErrorSink, CueTransport, TrackId } from '../../ports/driven';
import type { WebAudioGraph } from './WebAudioGraph';

/** Default ramp constants for a held voice. Fast up, slow down: something
 *  entering the frame has to be heard at once, and a voice that stops abruptly
 *  is more noticeable than one that fades. */
const RISE_S = 0.08;
const FALL_S = 0.22;

interface HeldVoice {
    source: AudioBufferSourceNode;
    gain: GainNode;
    panner: StereoPannerNode;
}

export class WebAudioCueTransport implements CueTransport {
    private readonly buffers = new Map<TrackId, AudioBuffer>();
    private readonly loading = new Map<TrackId, Promise<void>>();
    private readonly held = new Map<TrackId, HeldVoice>();

    constructor(
        private readonly graph: WebAudioGraph,
        private readonly onError: AudioErrorSink,
        private readonly fetchAsset: (path: AssetPath) => Promise<ArrayBuffer>,
    ) {}

    async load(id: TrackId, path: AssetPath): Promise<void> {
        if (this.buffers.has(id)) return;
        const pending = this.loading.get(id);
        if (pending) return pending;
        const ctx = this.graph.ensure();
        if (!ctx) return;

        const flight = (async () => {
            try {
                const bytes = await this.fetchAsset(path);
                this.buffers.set(id, await ctx.decodeAudioData(bytes));
            } catch (error) {
                this.onError(error, { op: 'cue-decode', id, path });
            } finally {
                this.loading.delete(id);
            }
        })();
        this.loading.set(id, flight);
        return flight;
    }

    play(id: TrackId, options?: { volume?: number; pan?: number }): void {
        const ctx = this.graph.ensure();
        const buffer = this.buffers.get(id);
        // A cue that was never warmed is skipped, not queued. For a
        // once-per-run sound, arriving half a second after the event is worse
        // than not arriving: the player has already moved on.
        if (!ctx || !buffer || !this.graph.cueBus) return;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        let tail: AudioNode = source;

        const volume = options?.volume ?? 1;
        if (volume !== 1) {
            const gain = ctx.createGain();
            gain.gain.value = volume;
            tail.connect(gain);
            tail = gain;
        }
        const pan = options?.pan ?? 0;
        if (pan !== 0) {
            const panner = ctx.createStereoPanner();
            panner.pan.value = Math.max(-1, Math.min(1, pan));
            tail.connect(panner);
            tail = panner;
        }
        tail.connect(this.graph.cueBus);
        source.start(ctx.currentTime);
        source.onended = () => {
            try {
                source.disconnect();
                if (tail !== source) tail.disconnect();
            } catch {
                /* already gone */
            }
        };
    }

    hold(
        id: TrackId,
        options: { volume: number; pan?: number; riseS?: number; fallS?: number },
    ): void {
        const existing = this.held.get(id);
        // Silence for a voice nobody is holding is not a request to start one.
        if (!existing && options.volume <= 0) return;
        const ctx = this.graph.ensure();
        if (!ctx || !this.graph.cueBus) return;

        const voice = existing ?? this.start(id, ctx);
        if (!voice) return;

        const now = ctx.currentTime;
        const rising = options.volume >= voice.gain.gain.value;
        const tau = rising ? (options.riseS ?? RISE_S) : (options.fallS ?? FALL_S);
        voice.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, options.volume)), now, tau);
        if (options.pan !== undefined) {
            voice.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, options.pan)), now, tau);
        }
    }

    releaseHold(id?: TrackId): void {
        const ids = id === undefined ? [...this.held.keys()] : [id];
        for (const key of ids) {
            const voice = this.held.get(key);
            if (!voice) continue;
            this.held.delete(key);
            try {
                voice.source.stop();
            } catch {
                /* already stopped */
            }
            try {
                voice.source.disconnect();
                voice.gain.disconnect();
                voice.panner.disconnect();
            } catch {
                /* already detached */
            }
        }
    }

    release(id: TrackId): void {
        this.releaseHold(id);
        this.buffers.delete(id);
        this.loading.delete(id);
    }

    dispose(): void {
        this.releaseHold();
        this.buffers.clear();
        this.loading.clear();
    }

    private start(id: TrackId, ctx: AudioContext): HeldVoice | null {
        const buffer = this.buffers.get(id);
        // Not warmed: silent, and said out loud. The transport is given ids and
        // paths together by `load`, so it cannot go and fetch one it was never
        // told about — inventing a path from the id is how a library starts
        // guessing at its host's layout.
        if (!buffer || !this.graph.cueBus) {
            if (!buffer) this.onError(new Error(`held voice '${id}' was never warmed`), { op: 'cue-hold', id });
            return null;
        }
        try {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            const gain = ctx.createGain();
            gain.gain.value = 0;
            const panner = ctx.createStereoPanner();
            source.connect(gain);
            gain.connect(panner);
            panner.connect(this.graph.cueBus);
            source.start();
            const voice: HeldVoice = { source, gain, panner };
            this.held.set(id, voice);
            return voice;
        } catch (error) {
            this.onError(error, { op: 'cue-hold', id });
            return null;
        }
    }
}
