// Driving port: the whole surface a host talks to.
//
// What is deliberately absent is as much of the design as what is present.
// There is no notion of a world, a level, a menu or a result screen here, and
// no list of tracks: *which* sound plays *when* is the game's story, and a
// library that knew it would have to be forked for the next game. The engine
// owns the machinery — the graph, the buses, the loop, the unlock, the
// lifecycle — and nothing else.

import type { AssetPath, TrackId } from '../driven';

/** How the engine's output is currently reaching the speaker. Hosts use it to
 *  report, never to branch: every control below behaves the same on all of
 *  them, which is the point of the library. */
export interface AudioStatus {
    /** False until a gesture unlocked the context, or an autostart succeeded. */
    readonly running: boolean;
    readonly muted: boolean;
    readonly musicTransport: 'web-audio' | 'native';
    readonly playing: TrackId | null;
}

export interface MusicController {
    /** Decodes/prepares a track without starting it. */
    warm(id: TrackId, path: AssetPath): Promise<void>;

    /** Plays `id`, looping, replacing whatever was playing.
     *
     *  When something is already playing the change is a **crossfade**, built
     *  on volume ramps so it behaves the same on every transport. Pass
     *  `crossfadeMs: 0` for a hard cut. */
    play(id: TrackId, path: AssetPath, options?: { crossfadeMs?: number }): Promise<void>;

    /** Stops and releases the current track. */
    stop(): Promise<void>;

    /** The music bus level, 0…1. The host owns the curve — the engine only
     *  owns the fact that changing it must not click. */
    setLevel(level: number): void;

    /** Pulls the music down under an important cue and lets it back up. Works
     *  on every transport because it is volume, not filtering: the version of
     *  this that used a low-pass existed only on the web, which is how a knob
     *  becomes a lie. */
    duck(amount: number, ms: number): void;

    /** Drops a preloaded track the host knows it will not need again. */
    release(id: TrackId): Promise<void>;
}

export interface CueController {
    /** Decodes a batch up front. Cues that are played cold are silent the
     *  first time, and for a once-per-run cue that is the right trade — but it
     *  must be a choice, so warming is explicit. */
    warm(entries: ReadonlyArray<{ id: TrackId; path: AssetPath }>): Promise<void>;
    play(id: TrackId, options?: { volume?: number; pan?: number }): void;

    /** Starts or updates a **held voice** — a cue that loops while something is
     *  near enough to be heard, and moves in the stereo field as it does.
     *  Written for a per-frame caller: one call is both start and update, and
     *  asking for silence on a voice nobody holds does nothing. */
    hold(
        id: TrackId,
        options: { volume: number; pan?: number; riseS?: number; fallS?: number },
    ): void;

    /** Tears down one held voice, or all of them. Do this when the run ends:
     *  held voices loop for ever, and one left alive plays on into the menu. */
    releaseHolds(id?: TrackId): void;

    /** The cue bus, 0…1. The counterpart of `music.setLevel`, and it exists for
     *  the same reason: how loud effects should be *relative to the music*
     *  depends on what the player is doing, and only the host knows that. A
     *  menu wants its clicks crisp; a run has a dozen cues a second over a
     *  track that has to stay audible under them. */
    setLevel(level: number): void;

    release(id: TrackId): void;
}

export interface AudioEngine {
    readonly music: MusicController;
    readonly cues: CueController;

    status(): AudioStatus;

    /** Call from any first user gesture. Idempotent, and cheap after the
     *  first time, so a host can wire it to every handler it has without
     *  thinking about which one fires first. */
    unlock(): void;

    /** Tries to start without a gesture, and reports whether it worked.
     *
     *  Browsers forbid this; a Capacitor WebView does not, because Capacitor
     *  turns off the gesture requirement. A host that only ever calls
     *  `unlock()` therefore ships a game that boots silent on a phone and
     *  nobody notices, because on a desktop browser that is the correct
     *  behavior. Returning a boolean instead of throwing lets the host keep
     *  the gesture path as a fallback rather than a workaround. */
    tryAutoStart(): Promise<boolean>;

    setMuted(muted: boolean): void;

    /** Follow the host application's lifecycle. Suspending releases the audio
     *  hardware; a session left open costs power even at zero volume. */
    suspend(): Promise<void>;
    resume(): Promise<void>;

    dispose(): Promise<void>;
}
