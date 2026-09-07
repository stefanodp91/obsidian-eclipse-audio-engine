// The Web Audio graph: the plumbing everything else hangs off.
//
//   master → limiter → destination
//   musicBus → master
//   cueBus   → master
//
// It owns the AudioContext lifecycle, including the two ways it can be
// started: a user gesture, and — where the platform allows it — no gesture at
// all.

/** Ceiling of the safety limiter, in dB below full scale.
 *
 *  **Below it nothing is touched**: this is a net, not a compressor that
 *  colors the mix. It exists because Web Audio does not clamp — it passes
 *  floats through and the platform clips at the final conversion, which sounds
 *  like a rasp and is invisible to every measurement made on the files. A mix
 *  of one music track and two normalized cues reaches full scale easily: cues
 *  mastered at -3 dBFS are 0.708 linear apiece. */
const LIMITER_CEILING_DB = -4;

export class WebAudioGraph {
    /** How much buffer to ask the platform for.
     *
     *  **`'interactive'` is the browser's default and the most fragile one**:
     *  the smallest buffer the hardware accepts, chosen to get a sound out as
     *  early as possible. On a phone that is also drawing a 3D scene, that
     *  margin is the first thing to go, and the symptom is tiny scratches that
     *  no measurement made on the file can explain.
     *
     *  `'balanced'` looked like the right compromise — an application has two
     *  jobs on the same graph, music that is in no hurry and a cue that has to
     *  land on the frame — and it **was not enough**: on a Pixel 9 Pro, tiny
     *  scratches remained. So the starting point is `'playback'`, the widest
     *  margin, and cue responsiveness becomes something to verify rather than
     *  to assume. A host that lives on promptness can go back knowing what it
     *  is trading away. */
    constructor(private readonly latencyHint: AudioContextLatencyCategory = 'playback') {}

    ctx: AudioContext | null = null;
    master: GainNode | null = null;
    limiter: DynamicsCompressorNode | null = null;
    musicBus: GainNode | null = null;
    cueBus: GainNode | null = null;

    private unlocked = false;
    private muted = false;
    /** Off because **there is nothing to hear**, which is a different thing
     *  from being muted: mute is a choice made by whoever is listening, this is
     *  a consequence of the levels. Keeping them apart is what lets `status()`
     *  say "not muted, but not audible either". */
    private dormant = false;

    get isUnlocked(): boolean {
        return this.unlocked;
    }

    get isMuted(): boolean {
        return this.muted;
    }

    /** True when the hardware is asleep because every bus is at zero. */
    get isDormant(): boolean {
        return this.dormant;
    }

    /** Puts the hardware to sleep, or wakes it, without touching mute.
     *
     *  **Why a gain of zero is not enough.** An open audio session costs power
     *  even in silence — on Android roughly 1.25 mAh/min of HAL session — so
     *  "every level at zero" and "audio off" are two different states, and only
     *  the second one gives the battery back. A host that forgets it never
     *  finds out: the application is correctly silent and draws power all the
     *  same. This is exactly the kind of thing a library has to do on its
     *  own. */
    setDormant(dormant: boolean): void {
        if (this.dormant === dormant) return;
        this.dormant = dormant;
        if (dormant) void this.ctx?.suspend();
        else if (!this.muted && this.ctx?.state === 'suspended') void this.ctx.resume();
    }

    /** Builds the context on the assumption a gesture has happened. */
    ensure(): AudioContext | null {
        if (!this.unlocked) return null;
        return this.ctx ?? this.build();
    }

    /** Marks the graph unlocked and builds it. Idempotent. */
    unlock(): AudioContext | null {
        this.unlocked = true;
        const ctx = this.ctx ?? this.build();
        if (ctx && !this.muted && ctx.state === 'suspended') void ctx.resume();
        return ctx;
    }

    /** Tries to start with no gesture at all, and tells the truth about it.
     *
     *  A context built where autoplay is allowed comes back `running`; where it
     *  is forbidden it comes back `suspended`, and some engines will still let
     *  a bare `resume()` through. Both are tried, in that order. On failure the
     *  graph stays locked — it does not pretend — and the suspended context is
     *  kept, because a later gesture then finds it already built instead of
     *  building it while the finger is still down. */
    async tryAutoStart(): Promise<boolean> {
        if (this.unlocked) return true;
        if (this.muted) return false;
        const ctx = this.ctx ?? this.build();
        if (!ctx) return false;
        if (ctx.state === 'running') {
            this.unlocked = true;
            return true;
        }
        try {
            await ctx.resume();
        } catch {
            return false;
        }
        if ((ctx.state as AudioContextState) !== 'running') return false;
        this.unlocked = true;
        return true;
    }

    setMuted(muted: boolean): void {
        this.muted = muted;
        if (this.master && this.ctx) {
            const t = this.ctx.currentTime;
            this.master.gain.cancelScheduledValues(t);
            this.master.gain.setTargetAtTime(muted ? 0 : 1, t, 0.02);
        }
        // Muting suspends the hardware rather than only zeroing a gain: a live
        // session costs power at any volume, and "silent but still draining"
        // is the shape of battery bug nobody reports.
        if (muted) void this.ctx?.suspend();
        else if (this.ctx?.state === 'suspended') void this.ctx.resume();
    }

    async suspend(): Promise<void> {
        if (this.ctx?.state === 'running') {
            try {
                await this.ctx.suspend();
            } catch {
                /* the context is going away anyway */
            }
        }
    }

    async resume(): Promise<void> {
        if (this.muted) return;
        if (this.ctx?.state === 'suspended') {
            try {
                await this.ctx.resume();
            } catch {
                /* a resume refused off a gesture is not an error here */
            }
        }
    }

    async dispose(): Promise<void> {
        const ctx = this.ctx;
        this.ctx = null;
        this.master = this.limiter = null;
        this.musicBus = this.cueBus = null;
        this.unlocked = false;
        try {
            await ctx?.close();
        } catch {
            /* already gone */
        }
    }

    private build(): AudioContext | null {
        try {
            const ctx = new AudioContext({ latencyHint: this.latencyHint });
            this.ctx = ctx;

            this.limiter = ctx.createDynamicsCompressor();
            this.limiter.threshold.value = LIMITER_CEILING_DB;
            this.limiter.knee.value = 0;
            this.limiter.ratio.value = 20;
            this.limiter.attack.value = 0.002;
            this.limiter.release.value = 0.15;
            this.limiter.connect(ctx.destination);

            this.master = ctx.createGain();
            this.master.gain.value = this.muted ? 0 : 1;
            this.master.connect(this.limiter);

            this.musicBus = ctx.createGain();
            this.musicBus.gain.value = 1;
            this.musicBus.connect(this.master);

            this.cueBus = ctx.createGain();
            this.cueBus.gain.value = 1;
            this.cueBus.connect(this.master);
        } catch {
            this.ctx = null;
            return null;
        }
        if (this.muted) void this.ctx.suspend();
        return this.ctx;
    }
}
