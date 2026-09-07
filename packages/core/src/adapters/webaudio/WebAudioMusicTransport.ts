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
// contract.

import type { AssetPath, AudioErrorSink, MusicTransport, TrackId } from '../../ports/driven';
import type { WebAudioGraph } from './WebAudioGraph';

interface Voice {
    source: AudioBufferSourceNode;
    gain: GainNode;
}

export class WebAudioMusicTransport implements MusicTransport {
    readonly kind = 'web-audio' as const;
    readonly gaplessLoop = true;

    private readonly buffers = new Map<TrackId, AudioBuffer>();
    private readonly loading = new Map<TrackId, Promise<AudioBuffer | null>>();
    private readonly voices = new Map<TrackId, Voice>();

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

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = options.loop;
        const gain = ctx.createGain();
        gain.gain.value = options.volume;
        source.connect(gain);
        gain.connect(this.graph.musicBus);
        source.start(ctx.currentTime);
        this.voices.set(id, { source, gain });
    }

    async setVolume(id: TrackId, volume: number): Promise<void> {
        const ctx = this.graph.ctx;
        const voice = this.voices.get(id);
        if (!ctx || !voice) return;
        const t = ctx.currentTime;
        voice.gain.gain.cancelScheduledValues(t);
        // A ramp and not an assignment: a step on a running signal is a click,
        // and the whole crossfade is built out of these.
        voice.gain.gain.setTargetAtTime(volume, t, 0.02);
    }

    async fade(id: TrackId, to: number, ms: number): Promise<void> {
        const ctx = this.graph.ctx;
        const voice = this.voices.get(id);
        if (!ctx || !voice) return;
        const t = ctx.currentTime;
        const gain = voice.gain.gain;
        gain.cancelScheduledValues(t);
        // The current value has to be pinned before the ramp, or `linearRamp`
        // interpolates from the last scheduled event rather than from where the
        // signal actually is.
        gain.setValueAtTime(gain.value, t);
        gain.linearRampToValueAtTime(to, t + Math.max(0.001, ms / 1000));
    }

    async stop(id: TrackId): Promise<void> {
        const voice = this.voices.get(id);
        if (!voice) return;
        this.voices.delete(id);
        try {
            voice.source.stop();
        } catch {
            /* already stopped */
        }
        try {
            voice.source.disconnect();
            voice.gain.disconnect();
        } catch {
            /* already detached */
        }
    }

    async release(id: TrackId): Promise<void> {
        await this.stop(id);
        this.buffers.delete(id);
        this.loading.delete(id);
    }

    async dispose(): Promise<void> {
        for (const id of [...this.voices.keys()]) await this.stop(id);
        this.buffers.clear();
        this.loading.clear();
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
