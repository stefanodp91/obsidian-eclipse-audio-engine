// Driven ports: what the engine needs from the outside world.
//
// The rule that shapes this file is the one that produced the defect this
// library exists to fix. A game that plays its music through one transport on
// the web and a different one on the device does not have one behavior with
// two implementations — it has two behaviors, and only one of them is ever
// under test. Knobs quietly stop existing on the platform nobody profiles.
//
// So `MusicTransport` is deliberately the **intersection** of what every
// transport can do, not the union. Everything richer — crossfade, ducking,
// intensity — is built on top of it in the application layer, out of volume
// ramps, and therefore behaves the same everywhere.

/** An opaque handle chosen by the host: the engine never parses it. */
export type TrackId = string;

/** Where a file lives, expressed the way the host publishes it: a path
 *  relative to the web assets root (`audio/bgm/menu.m4a`). Each transport
 *  knows how to turn that into something its platform can open — a fetch on
 *  the web, `file:///android_asset/public/…` on Android, a bundle URL on iOS.
 *  The host must not have to know which. */
export type AssetPath = string;

/** Plays one long stream that loops for minutes at a time.
 *
 *  **Implementations must not request compressed audio offload.** On Android
 *  the DSP offload path decodes AAC on a coprocessor to save power, and on at
 *  least one shipping device family (Tensor, measured 2026-09-07 on a Pixel 9
 *  Pro against a Galaxy A25 with the same build and the same file) it renders
 *  a plain 44.1 kHz AAC stream with an audible rasp. In Media3 offload is
 *  opt-in, so the requirement costs nothing but has to be *stated*, or a
 *  future contributor will enable it for the battery win and reopen this. */
export interface MusicTransport {
    /** Which platform mechanism is behind this transport. Diagnostics only:
     *  the engine never branches on it, and neither should a host. */
    readonly kind: 'web-audio' | 'native';

    /** True when the transport loops without inserting silence at the seam.
     *  A transport that cannot must say so: the application layer then closes
     *  the loop itself instead of trusting it. Web Audio buffer sources are
     *  sample-exact; a platform player is only gapless if it honors the
     *  encoder delay and padding written by the encoder. */
    readonly gaplessLoop: boolean;

    /** Makes the track ready to start without a further round trip. Calling it
     *  twice for the same id must be harmless. */
    preload(id: TrackId, path: AssetPath): Promise<void>;

    /** Starts the track. `volume` is linear 0…1 — the caller has already
     *  applied whatever curve it wants. */
    play(id: TrackId, options: { loop: boolean; volume: number }): Promise<void>;

    /** Linear 0…1, applied as promptly as the platform allows. */
    setVolume(id: TrackId, volume: number): Promise<void>;

    /** Slides the volume to `to` over `ms`, **smoothly, from inside the
     *  transport**.
     *
     *  ⚠️ **This was not here, and its absence was an audible defect.** The
     *  first version built fades one layer up, out of twenty `setVolume` calls
     *  spread over time: it looked like the right choice — keep the port
     *  minimal and write the rest once — and it was wrong for the exact reason
     *  that principle is meant to prevent. Every write is an **instantaneous
     *  gain step on a stream that is sounding**, and twenty steps in eight
     *  hundred milliseconds are heard as scratches. Measured on a Pixel 9 Pro
     *  on 2026-09-08: "heavy scratching on the transition between two screens
     *  of a consumer application", which is exactly where the fade runs.
     *
     *  Every transport does this better than a caller driving it from outside —
     *  Web Audio with a sample-by-sample ramp, a platform player from its own
     *  thread without crossing a bridge — so it belongs to the intersection,
     *  not to the layer above. The rule that comes out of it: **the
     *  intersection is not the set of the smallest commands, it is the set of
     *  the things every transport does better than its caller.** */
    fade(id: TrackId, to: number, ms: number): Promise<void>;

    stop(id: TrackId): Promise<void>;

    /** Frees whatever the transport is holding for this id — decoded buffer,
     *  player instance, HAL session. A track that was never preloaded must be
     *  released without complaint. */
    release(id: TrackId): Promise<void>;

    /** Releases everything, for teardown. */
    dispose(): Promise<void>;
}

/** Plays short cues that must start *now*.
 *
 *  There is one implementation and it is Web Audio, on every platform. That is
 *  a design statement, not a gap: a cue is tens of milliseconds long, and the
 *  round trip across a native bridge costs more than hardware decoding saves.
 *  The port exists so the claim stays falsifiable — a platform where it turns
 *  out to be wrong can implement it — not because a second one is planned. */
export interface CueTransport {
    load(id: TrackId, path: AssetPath): Promise<void>;
    /** `pan` is -1…1; a transport that cannot pan must ignore it rather than
     *  refuse to play. */
    play(id: TrackId, options?: { volume?: number; pan?: number }): void;

    /** Starts or updates a **held voice**: a cue that loops for as long as
     *  something in the world is near enough to be heard, moving in the stereo
     *  field as it does.
     *
     *  It is one call for both "start" and "update" because the caller is a
     *  per-frame loop and should not have to remember which voices exist. Two
     *  rules make that safe, and both are contract rather than implementation:
     *
     *  - **volume 0 on a voice that is not held does nothing.** A frame that
     *    reports "nothing near" must not bring a voice into being just to
     *    silence it;
     *  - a held voice is **not torn down when it reaches zero**, because the
     *    thing that left the radius usually comes back within a few frames, and
     *    rebuilding a source costs more than leaving one silent.
     *
     *  `riseS`/`fallS` are ramp time constants. The asymmetry is the point and
     *  the default: something entering the frame has to be heard at once, while
     *  a voice that stops abruptly is more noticeable than one that fades. */
    hold(
        id: TrackId,
        options: { volume: number; pan?: number; riseS?: number; fallS?: number },
    ): void;

    /** Stops and tears down one held voice, or all of them. Held voices loop
     *  for ever by construction: one left alive plays on into the menu. */
    releaseHold(id?: TrackId): void;

    release(id: TrackId): void;
    dispose(): void;
}

/** Reads and writes the one bit the engine persists across launches. Hosts
 *  usually already own storage; the engine refuses to pick one for them. */
export interface MutePreference {
    read(): boolean;
    write(muted: boolean): void;
}

/** Where the engine reports what it swallowed. Every failure inside a
 *  transport ends here instead of in a bare `catch`, because an audio defect
 *  that only makes the game quieter is exactly the kind that ships. */
export interface AudioErrorSink {
    (error: unknown, context: { op: string; id?: TrackId; path?: AssetPath }): void;
}
