// The application layer: everything that must behave identically on every
// transport, written once, out of the one control they all have.
//
// Crossfade, ducking and the music level are not transport features here. They
// are volume ramps driven from this file, stepped in time, so a platform
// player that can only be told "set the volume to 0.62" gets the same
// behavior as a Web Audio graph with sample-accurate automation. That is the
// whole reason the driven port is an intersection: the moment one transport
// grows a feature the others lack, the game acquires a knob that exists on one
// platform, and nobody finds out until someone profiles the other one.

import type {
    AssetPath,
    AudioErrorSink,
    CueTransport,
    MusicTransport,
    MutePreference,
    TrackId,
} from '../ports/driven';
import type { AudioEngine, AudioStatus, CueController, MusicController } from '../ports/driving';
import type { WebAudioGraph } from '../adapters/webaudio/WebAudioGraph';

/** **`NaN` does not get through here**, and the reason is that a `NaN` gain does
 *  not produce silence: it produces *the previous value*, which in practice is
 *  full volume. The first version was `v < 0 ? 0 : v > 1 ? 1 : v`, which on
 *  `NaN` fails both comparisons and returns it intact — a limiter that lets
 *  through the one value it was there to protect against.
 *
 *  The defect came from the host (a field read before it was initialized), but
 *  it is the library that has to stop it: a level that is not a number is the
 *  caller's mistake, and the right answer is **zero**, not the maximum. Of the
 *  two possible errors, going quiet is the one that gets noticed. */
const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** How long to wait before putting the hardware to sleep, once every bus has
 *  reached zero. One and a fifth seconds: long enough not to react to a zero in
 *  passing — a fade, a slider dragged across the bottom — and short enough not
 *  to hand power away to an application left in silence. */
const SLEEP_AFTER_MS = 1200;

export interface AudioEngineDeps {
    graph: WebAudioGraph;
    music: MusicTransport;
    cues: CueTransport;
    mutePreference: MutePreference;
    onError: AudioErrorSink;
    /** Injected so tests can run the clock instead of waiting on it. */
    sleep?: (ms: number) => Promise<void>;
}

export class DefaultAudioEngine implements AudioEngine {
    readonly music: MusicController;
    readonly cues: CueController;

    private current: TrackId | null = null;
    private level = 1;
    private duckFactor = 1;
    /** Bumped on every change that invalidates a ramp in flight, so a fade
     *  whose track was replaced mid-flight stops writing volumes for a track
     *  nobody is listening to any more. */
    private generation = 0;
    private duckTimer: ReturnType<typeof setTimeout> | null = null;
    /** Tracks still audible after a change on the beat replaced them: they
     *  play on until the beat, then fade. Counted, because the same id can be
     *  handed over twice before the first fade ends. Empty unless a host asked
     *  for `alignS`. */
    private readonly outgoing = new Map<TrackId, number>();

    /** The levels of the two buses, kept here so the library can decide for
     *  itself when there is nothing left to hear. */
    private musicLevel = 1;
    private cueLevel = 1;
    private sleepTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly sleep: (ms: number) => Promise<void>;

    constructor(private readonly deps: AudioEngineDeps) {
        this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.deps.graph.setMuted(deps.mutePreference.read());
        this.music = this.buildMusicController();
        this.cues = this.buildCueController();
    }

    /** **`running` means "sound can be heard right now"**, and computing it
     *  per transport is not a detail. The first version read the Web Audio
     *  context's state unconditionally — which on a native transport describes
     *  the graph the *cues* go through and says nothing about the music. The
     *  sample caught it on its first run on a device: the engine reported
     *  `running: false` while the platform mixer showed an active track. A
     *  status that can be wrong about the thing it exists to report is worse
     *  than no status, because it is the one a host puts in its telemetry. */
    status(): AudioStatus {
        const graph = this.deps.graph;
        const audible = graph.isUnlocked && !graph.isMuted && !graph.isDormant;
        return {
            running:
                this.deps.music.kind === 'native'
                    ? audible
                    : audible && graph.ctx?.state === 'running',
            muted: graph.isMuted,
            musicTransport: this.deps.music.kind === 'native' ? 'native' : 'web-audio',
            playing: this.current,
        };
    }

    unlock(): void {
        this.deps.graph.unlock();
    }

    tryAutoStart(): Promise<boolean> {
        return this.deps.graph.tryAutoStart();
    }

    setMuted(muted: boolean): void {
        this.deps.graph.setMuted(muted);
        this.deps.mutePreference.write(muted);
        // The native transport is not inside the Web Audio graph, so muting
        // the master says nothing to it. It is told directly, and stopped
        // rather than silenced: an open session draws power at zero volume.
        if (this.deps.music.kind === 'native' && this.current) {
            const id = this.current;
            if (muted) void this.deps.music.stop(id).catch((e) => this.fail(e, 'mute-stop', id));
            else void this.deps.music.play(id, { loop: true, volume: this.effective() });
        }
    }

    async suspend(): Promise<void> {
        await this.deps.graph.suspend();
    }

    async resume(): Promise<void> {
        await this.deps.graph.resume();
    }

    async dispose(): Promise<void> {
        this.generation += 1;
        if (this.duckTimer) clearTimeout(this.duckTimer);
        if (this.sleepTimer) clearTimeout(this.sleepTimer);
        this.deps.cues.dispose();
        await this.deps.music.dispose();
        await this.deps.graph.dispose();
    }

    // ── music ────────────────────────────────────────────────────────────

    private buildMusicController(): MusicController {
        return {
            warm: async (id, path) => {
                try {
                    await this.deps.music.preload(id, path);
                } catch (error) {
                    this.fail(error, 'warm', id, path);
                }
            },

            play: async (id, path, options) => {
                if (this.current === id) return;
                const crossfadeMs = options?.crossfadeMs ?? 800;
                const previous = this.current;
                const mine = ++this.generation;

                try {
                    await this.deps.music.preload(id, path);
                } catch (error) {
                    this.fail(error, 'preload', id, path);
                    return;
                }
                if (mine !== this.generation) return;

                this.current = id;
                const target = this.effective();

                // **Muted means silent, including for a track that starts while
                // muted.** On Web Audio this was free — the master gain is zero
                // and the context suspended — so the hole only existed on the
                // native transport, which is outside the graph and hears none
                // of that. The sample found it on a device: the engine reported
                // `muted: true` while the platform mixer showed an active track
                // at −22 dB. The track is still recorded as current, so
                // `setMuted(false)` starts it, which is what a player expects
                // from unmuting.
                if (this.deps.graph.isMuted) {
                    if (this.outgoing.size > 0) await this.stopOutgoing(id);
                    if (previous) await this.quietly(() => this.deps.music.stop(previous), 'stop', previous);
                    if (previous && previous !== id) {
                        await this.quietly(() => this.deps.music.release(previous), 'release', previous);
                    }
                    return;
                }

                const alignS = options?.alignS;
                const playAligned = this.deps.music.playAligned?.bind(this.deps.music);
                if (
                    previous !== null &&
                    playAligned &&
                    alignS !== undefined &&
                    Number.isFinite(alignS) &&
                    alignS > 0
                ) {
                    await this.handOver(playAligned, id, previous, {
                        alignS,
                        fadeMs: Math.max(0, crossfadeMs),
                        volume: target,
                    });
                    return;
                }

                // A change that does not wait for the beat also takes along
                // what an earlier one left still sounding.
                this.fadeOutgoing(id, previous === null ? 0 : crossfadeMs);

                if (previous === null || crossfadeMs <= 0) {
                    if (previous) await this.quietly(() => this.deps.music.stop(previous), 'stop', previous);
                    await this.quietly(
                        () => this.deps.music.play(id, { loop: true, volume: target }),
                        'play',
                        id,
                    );
                } else {
                    await this.quietly(
                        () => this.deps.music.play(id, { loop: true, volume: 0 }),
                        'play',
                        id,
                    );
                    // **The transport does the fade**, not this layer. The
                    // first version stepped it here in twenty `setVolume`
                    // calls, and every write is a gain step on a stream that is
                    // sounding: on a transport reachable only across a bridge,
                    // twenty steps in eight hundred milliseconds are audible.
                    // The intersection principle still holds, but it has to be
                    // read properly: it is not "the smallest commands", it is
                    // "the things every transport does better than its caller".
                    await Promise.all([
                        this.quietly(() => this.deps.music.fade(id, target, crossfadeMs), 'fade', id),
                        this.quietly(() => this.deps.music.fade(previous, 0, crossfadeMs), 'fade', previous),
                    ]);
                    await this.sleep(crossfadeMs);
                    if (mine !== this.generation) return;
                    await this.quietly(() => this.deps.music.stop(previous), 'stop', previous);
                }
                if (previous && previous !== id) {
                    await this.quietly(() => this.deps.music.release(previous), 'release', previous);
                }
            },

            stop: async () => {
                const id = this.current;
                this.current = null;
                this.generation += 1;
                if (this.outgoing.size > 0) await this.stopOutgoing(id);
                if (!id) return;
                await this.quietly(() => this.deps.music.stop(id), 'stop', id);
                await this.quietly(() => this.deps.music.release(id), 'release', id);
            },

            setLevel: (level) => {
                this.level = clamp01(level);
                this.musicLevel = this.level;
                this.pushVolume();
                this.evaluateSleep();
            },

            duck: (amount, ms) => {
                this.duckFactor = clamp01(amount);
                this.pushVolume();
                if (this.duckTimer) clearTimeout(this.duckTimer);
                this.duckTimer = setTimeout(() => {
                    this.duckFactor = 1;
                    this.pushVolume();
                }, Math.max(0, ms));
            },

            release: async (id) => {
                if (id === this.current) return; // releasing what is playing is a stop, not a release
                await this.quietly(() => this.deps.music.release(id), 'release', id);
            },
        };
    }

    private buildCueController(): CueController {
        return {
            warm: async (entries) => {
                await Promise.all(
                    entries.map(({ id, path }) =>
                        this.deps.cues.load(id, path).catch((e) => this.fail(e, 'cue-warm', id, path)),
                    ),
                );
            },
            play: (id, options) => this.deps.cues.play(id, options),
            hold: (id, options) => this.deps.cues.hold(id, options),
            releaseHolds: (id) => this.deps.cues.releaseHold(id),
            setLevel: (level) => {
                this.cueLevel = clamp01(level);
                const graph = this.deps.graph;
                const ctx = graph.ctx;
                this.evaluateSleep();
                if (!ctx || !graph.cueBus) return;
                const t = ctx.currentTime;
                graph.cueBus.gain.cancelScheduledValues(t);
                // A ramp and not an assignment: the bus may have cues in
                // flight, and a step on a sounding signal is a click.
                graph.cueBus.gain.setTargetAtTime(this.cueLevel, t, 0.03);
            },
            release: (id) => this.deps.cues.release(id),
        };
    }

    // ── the one mechanism the two controls share ─────────────────────────

    private effective(): number {
        return clamp01(this.level * this.duckFactor);
    }

    private pushVolume(): void {
        // The track a change on the beat is waiting to replace is the one the
        // listener hears: a duck that skipped it would duck nothing.
        for (const out of this.outgoing.keys()) {
            if (out === this.current) continue;
            void this.quietly(() => this.deps.music.setVolume(out, this.effective()), 'volume', out);
        }
        const id = this.current;
        if (!id) return;
        void this.quietly(() => this.deps.music.setVolume(id, this.effective()), 'volume', id);
    }

    // ── the change on the beat ───────────────────────────────────────────

    /** **The transport does the whole change**, start, fades and stop, on its
     *  own clock: a start placed from up here would land wherever the main
     *  thread happened to be, which is precisely the thing a change on the beat
     *  exists to avoid. This layer only keeps the books — which track is still
     *  audible, so `stop()` and a duck reach it — and releases the old track
     *  once the transport says it has stopped. */
    private async handOver(
        playAligned: NonNullable<MusicTransport['playAligned']>,
        id: TrackId,
        previous: TrackId,
        options: { alignS: number; fadeMs: number; volume: number },
    ): Promise<void> {
        this.outgoing.set(previous, (this.outgoing.get(previous) ?? 0) + 1);
        try {
            await playAligned(id, { after: previous, loop: true, ...options });
        } catch (error) {
            this.fail(error, 'play-aligned', id);
        } finally {
            const left = (this.outgoing.get(previous) ?? 0) - 1;
            if (left > 0) this.outgoing.set(previous, left);
            else this.outgoing.delete(previous);
        }
        // Asked for again while it was fading out: it is the current track
        // once more, and releasing it would silence it.
        if (previous === this.current) return;
        await this.quietly(() => this.deps.music.release(previous), 'release', previous);
    }

    /** Fades out whatever a change on the beat left sounding, for a change
     *  that does not wait. The transport stops each one at the end of its own
     *  fade and the change that started it releases it; this only makes sure
     *  it is silent by then. `id` is left alone: playing it restarts it. */
    private fadeOutgoing(id: TrackId, ms: number): void {
        for (const out of [...this.outgoing.keys()]) {
            if (out === id) continue;
            this.outgoing.delete(out);
            void this.quietly(
                () => (ms > 0 ? this.deps.music.fade(out, 0, ms) : this.deps.music.stop(out)),
                ms > 0 ? 'fade' : 'stop',
                out,
            );
        }
    }

    /** `stop()` means silence, including for a track still waiting for the
     *  beat to fade out. */
    private async stopOutgoing(except: TrackId | null): Promise<void> {
        for (const out of [...this.outgoing.keys()]) {
            if (out === except) continue;
            this.outgoing.delete(out);
            await this.quietly(() => this.deps.music.stop(out), 'stop', out);
            await this.quietly(() => this.deps.music.release(out), 'release', out);
        }
    }

    /** **The hardware switches itself off when there is nothing left to
     *  hear**, and this is the library's responsibility rather than the host's.
     *
     *  Taking the levels to zero makes the application silent but leaves the
     *  audio session open, which on Android costs roughly 1.25 mAh/min anyway.
     *  A host that does not know it ships an application that is correctly
     *  silent and draws power all the same — and never finds out, because there
     *  is nothing to hear and nothing else to see.
     *
     *  Waking is immediate, sleeping is deferred: a level passing through zero
     *  while a slider is being dragged must not suspend the context and then
     *  reopen it, because that coming and going is audible. */
    private evaluateSleep(): void {
        const silent = this.musicLevel <= 0 && this.cueLevel <= 0;
        if (this.sleepTimer) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = null;
        }
        if (!silent) {
            this.deps.graph.setDormant(false);
            return;
        }
        this.sleepTimer = setTimeout(() => {
            this.sleepTimer = null;
            if (this.musicLevel <= 0 && this.cueLevel <= 0) this.deps.graph.setDormant(true);
        }, SLEEP_AFTER_MS);
    }

    private async quietly(
        op: () => Promise<unknown>,
        name: string,
        id?: TrackId,
    ): Promise<void> {
        try {
            await op();
        } catch (error) {
            this.fail(error, name, id);
        }
    }

    private fail(error: unknown, op: string, id?: TrackId, path?: AssetPath): void {
        this.deps.onError(error, { op, ...(id ? { id } : {}), ...(path ? { path } : {}) });
    }
}
