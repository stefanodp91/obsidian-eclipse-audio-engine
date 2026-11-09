// These tests exist to hold one claim: the controls a game actually uses —
// crossfade, ducking, level — are written against `setVolume` alone, so they
// behave identically on a transport that can do nothing else.
//
// The fake below can do nothing else. If a crossfade ever starts needing a
// feature only Web Audio has, these fail, and that is the whole point.

import { describe, expect, it, vi } from 'vitest';
import { DefaultAudioEngine } from './DefaultAudioEngine';
import { inMemoryMutePreference } from '../adapters/memory/mutePreference';
import type { CueTransport, MusicTransport, TrackId } from '../ports/driven';
import type { WebAudioGraph } from '../adapters/webaudio/WebAudioGraph';

interface VolumeCall {
    id: TrackId;
    volume: number;
}

class FakeMusicTransport implements MusicTransport {
    readonly kind = 'native' as const;
    readonly gaplessLoop = true;
    readonly preloaded: TrackId[] = [];
    readonly played: TrackId[] = [];
    readonly stopped: TrackId[] = [];
    readonly released: TrackId[] = [];
    readonly volumes: VolumeCall[] = [];
    readonly fades: Array<{ id: TrackId; to: number; ms: number }> = [];

    async preload(id: TrackId): Promise<void> {
        this.preloaded.push(id);
    }
    async play(id: TrackId, options: { loop: boolean; volume: number }): Promise<void> {
        this.played.push(id);
        this.volumes.push({ id, volume: options.volume });
    }
    async setVolume(id: TrackId, volume: number): Promise<void> {
        this.volumes.push({ id, volume });
    }
    async fade(id: TrackId, to: number, ms: number): Promise<void> {
        this.fades.push({ id, to, ms });
    }
    async stop(id: TrackId): Promise<void> {
        this.stopped.push(id);
    }
    async release(id: TrackId): Promise<void> {
        this.released.push(id);
    }
    async dispose(): Promise<void> {}
}

const noCues: CueTransport = {
    load: async () => {},
    play: () => {},
    hold: () => {},
    releaseHold: () => {},
    release: () => {},
    dispose: () => {},
};

/** Enough of the graph for the application layer; the real one needs a DOM.
 *
 *  Mute is **stateful** here and not a stub. The first version of this fake
 *  answered `false` for ever, which quietly made two real defects untestable —
 *  they had to be found on a phone instead. A fake that cannot say no is a fake
 *  that agrees with whatever the code does. */
const fakeGraph = (): WebAudioGraph => {
    let muted = false;
    let dormant = false;
    return {
        ctx: null,
        isUnlocked: true,
        get isMuted() {
            return muted;
        },
        setMuted: (next: boolean) => {
            muted = next;
        },
        get isDormant() {
            return dormant;
        },
        setDormant: (next: boolean) => {
            dormant = next;
        },
        suspend: async () => {},
        resume: async () => {},
        dispose: async () => {},
        unlock: () => null,
        tryAutoStart: async () => true,
        ensure: () => null,
    } as unknown as WebAudioGraph;
};

const build = (music: FakeMusicTransport) =>
    new DefaultAudioEngine({
        graph: fakeGraph(),
        music,
        cues: noCues,
        mutePreference: inMemoryMutePreference(false),
        onError: () => {},
        sleep: async () => {}, // the ramp runs at once; only its shape is under test
    });

describe('music crossfade', () => {
    it('asks the transport for the fade instead of stepping it from up here', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);

        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        music.fades.length = 0;
        music.volumes.length = 0;
        await engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 800 });

        // Two requests only, one per track, carrying the duration: the
        // transport does it better than anyone stepping it from outside — and
        // on a transport behind a bridge, stepping it from outside is audible.
        expect(music.fades).toEqual([
            { id: 'b', to: 1, ms: 800 },
            { id: 'a', to: 0, ms: 800 },
        ]);
        // And no steps: if a `setVolume` reappears here, the fade has gone back
        // to being built in the wrong layer.
        expect(music.volumes.filter((c) => c.id === 'a')).toHaveLength(0);
    });

    it('stops and releases the track it faded out of', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        await engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 100 });
        expect(music.stopped).toContain('a');
        expect(music.released).toContain('a');
        expect(music.released).not.toContain('b');
    });

    it('does nothing when asked for the track already playing', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        const playedOnce = music.played.length;
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        expect(music.played.length).toBe(playedOnce);
    });
});

describe('ducking and level', () => {
    it('pulls the music down and lets it back up on its own', async () => {
        vi.useFakeTimers();
        try {
            const music = new FakeMusicTransport();
            const engine = build(music);
            await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
            music.volumes.length = 0;

            engine.music.duck(0.35, 400);
            expect(music.volumes.at(-1)?.volume).toBeCloseTo(0.35, 5);

            vi.advanceTimersByTime(400);
            expect(music.volumes.at(-1)?.volume).toBeCloseTo(1, 5);
        } finally {
            vi.useRealTimers();
        }
    });

    it('multiplies level and duck instead of letting one overwrite the other', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });

        engine.music.setLevel(0.5);
        engine.music.duck(0.4, 10_000);
        expect(music.volumes.at(-1)?.volume).toBeCloseTo(0.2, 5);
    });
});

// Both of these were found by the sample on its first run on a Pixel, not by
// reading the code. They are here so they cannot come back quietly.
describe('mute is not a suggestion', () => {
    it('does not start a track that is asked for while muted', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);
        engine.setMuted(true);

        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });

        expect(music.played).toHaveLength(0);
        // Still remembered, so unmuting starts it: that is what a player expects.
        expect(engine.status().playing).toBe('a');
    });

    it('reports running honestly on a transport outside the Web Audio graph', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);
        // The fake graph has no AudioContext at all, which is precisely the
        // case the first version got wrong.
        expect(engine.status().running).toBe(true);
        engine.setMuted(true);
        expect(engine.status().running).toBe(false);
    });
});

// The host never asks for the hardware to be switched off: it only asks for
// silence, and the library understands that they are the same thing. A host
// that had to remember it would ship an application that goes quiet and draws
// power all the same.
describe('silence and battery', () => {
    it('puts the hardware to sleep once every bus is at zero, but only after a moment', () => {
        vi.useFakeTimers();
        try {
            const music = new FakeMusicTransport();
            const engine = build(music);

            engine.music.setLevel(0);
            engine.cues.setLevel(0);
            // Not straight away: a zero in passing must not suspend and reopen.
            expect(engine.status().running).toBe(true);

            vi.advanceTimersByTime(1200);
            expect(engine.status().running).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('wakes up at once as soon as something becomes audible again', () => {
        vi.useFakeTimers();
        try {
            const music = new FakeMusicTransport();
            const engine = build(music);
            engine.music.setLevel(0);
            engine.cues.setLevel(0);
            vi.advanceTimersByTime(1200);
            expect(engine.status().running).toBe(false);

            engine.cues.setLevel(0.3);
            // No wait on waking: the delay protects the battery, it cannot cost
            // a sound.
            expect(engine.status().running).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not sleep while either of the two buses is still sounding', () => {
        vi.useFakeTimers();
        try {
            const music = new FakeMusicTransport();
            const engine = build(music);
            engine.music.setLevel(0);
            engine.cues.setLevel(0.4);
            vi.advanceTimersByTime(5000);
            expect(engine.status().running).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a level that is not a number', () => {
    it('counts as zero and not as the maximum', async () => {
        const music = new FakeMusicTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        music.volumes.length = 0;

        // A host that reads a field before initializing it sends NaN. The first
        // version of `clamp01` returned it intact, and a NaN gain leaves the
        // previous value standing: the application started at full volume.
        engine.music.setLevel(Number.NaN);

        expect(music.volumes.at(-1)?.volume).toBe(0);
    });
});

/** A transport that can also change on the beat. The change itself — where,
 *  from which position, with which fades — is the transport's and is tested
 *  there; what is under test here is what the engine asks for, what it does
 *  meanwhile, and what it releases once the transport reports the old track
 *  stopped. Each change waits until the test calls `finish()`. */
class FakeAligningTransport extends FakeMusicTransport {
    readonly aligned: Array<{
        id: TrackId;
        options: { after: TrackId; alignS: number; fadeMs: number; loop: boolean; volume: number };
    }> = [];
    private readonly pending: Array<() => void> = [];

    playAligned(
        id: TrackId,
        options: { after: TrackId; alignS: number; fadeMs: number; loop: boolean; volume: number },
    ): Promise<void> {
        this.aligned.push({ id, options });
        return new Promise((resolve) => this.pending.push(resolve));
    }

    /** The outgoing track of the oldest change has stopped. */
    finish(): void {
        this.pending.shift()?.();
    }
}

/** Lets the engine run up to its next real wait. */
const settle = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('a change on the beat', () => {
    it('hands the whole change to the transport, with the grid and the crossfade', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        music.fades.length = 0;
        engine.music.setLevel(0.5);

        const change = engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 2000, alignS: 7.5 });
        await settle();

        expect(music.aligned).toEqual([
            { id: 'b', options: { after: 'a', alignS: 7.5, fadeMs: 2000, loop: true, volume: 0.5 } },
        ]);
        // No fade from up here, and no stop: both are placed by the transport
        // on its own clock.
        expect(music.fades).toEqual([]);
        expect(music.stopped).not.toContain('a');
        expect(engine.status().playing).toBe('b');

        // a is released only once the transport says it has stopped.
        expect(music.released).not.toContain('a');
        music.finish();
        await change;
        expect(music.released).toEqual(['a']);
    });

    it('starts at once from zero when nothing is playing', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);

        await engine.music.play('a', 'audio/a.m4a', { alignS: 7.5 });

        expect(music.aligned).toEqual([]);
        expect(music.played).toEqual(['a']);
    });

    it('leaves a play without the option exactly as it was', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        music.fades.length = 0;

        await engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 800 });

        expect(music.aligned).toEqual([]);
        expect(music.fades).toEqual([
            { id: 'b', to: 1, ms: 800 },
            { id: 'a', to: 0, ms: 800 },
        ]);
        expect(music.stopped).toContain('a');
        expect(music.released).toContain('a');
    });

    it('ignores a grid that is not a finite positive number', async () => {
        for (const alignS of [0, -7.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            const music = new FakeAligningTransport();
            const engine = build(music);
            await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
            await engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 800, alignS });
            expect(music.aligned).toEqual([]);
            expect(music.played).toEqual(['a', 'b']);
        }
    });

    it('falls back to the ordinary crossfade on a transport that cannot align', async () => {
        const music = new FakeMusicTransport(); // no `playAligned`
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        music.fades.length = 0;

        await engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 800, alignS: 7.5 });

        expect(music.fades).toEqual([
            { id: 'b', to: 1, ms: 800 },
            { id: 'a', to: 0, ms: 800 },
        ]);
        expect(music.released).toContain('a');
    });

    it('ducks the track still sounding while the change waits for the beat', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        void engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 2000, alignS: 7.5 });
        await settle();
        music.volumes.length = 0;

        engine.music.duck(0.4, 10_000);

        expect(music.volumes).toEqual([
            { id: 'a', volume: 0.4 },
            { id: 'b', volume: 0.4 },
        ]);
    });

    it('stop() silences the track still waiting for the beat to fade out', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        void engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 2000, alignS: 7.5 });
        await settle();

        await engine.music.stop();

        expect(music.stopped).toEqual(expect.arrayContaining(['a', 'b']));
        expect(music.released).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('an ordinary change made meanwhile fades out the track still sounding too', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        void engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 2000, alignS: 7.5 });
        await settle();
        music.fades.length = 0;

        await engine.music.play('menu', 'audio/menu.m4a', { crossfadeMs: 800 });

        expect(music.fades).toEqual(
            expect.arrayContaining([
                { id: 'a', to: 0, ms: 800 },
                { id: 'menu', to: 1, ms: 800 },
                { id: 'b', to: 0, ms: 800 },
            ]),
        );
        // Released by the change that handed it over, once it has stopped.
        music.finish();
        await settle();
        expect(music.released).toContain('a');
    });

    it('does not release a track asked for again while it was fading out', async () => {
        const music = new FakeAligningTransport();
        const engine = build(music);
        await engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 0 });
        void engine.music.play('b', 'audio/b.m4a', { crossfadeMs: 2000, alignS: 7.5 });
        await settle();
        void engine.music.play('a', 'audio/a.m4a', { crossfadeMs: 2000, alignS: 7.5 });
        await settle();

        music.finish(); // a's old voice has stopped
        music.finish(); // b, which never sounded, has stopped
        await settle();

        expect(engine.status().playing).toBe('a');
        expect(music.released).toEqual(['b']);
    });
});
