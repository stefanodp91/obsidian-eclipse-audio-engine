// These tests hold the change on the beat: where the incoming track starts, at
// which position, how the two fades are laid out on the audio clock, and that
// nothing of it touches a `play` made the ordinary way.
//
// The fake context records every scheduled event and lets the test move the
// audio clock by hand. That is the point of it: the change is placed on
// `currentTime`, and a version that read the system clock instead would pass a
// test that let both run together.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebAudioMusicTransport } from './WebAudioMusicTransport';
import type { WebAudioGraph } from './WebAudioGraph';
import type { TrackId } from '../../ports/driven';

type ParamEvent = [string, ...number[]];

class FakeParam {
    value = 1;
    readonly events: ParamEvent[] = [];
    cancelScheduledValues(t: number): void {
        this.events.push(['cancel', t]);
    }
    setValueAtTime(v: number, t: number): void {
        this.events.push(['set', v, t]);
    }
    setTargetAtTime(v: number, t: number, c: number): void {
        this.events.push(['target', v, t, c]);
    }
    linearRampToValueAtTime(v: number, t: number): void {
        this.events.push(['ramp', v, t]);
    }
}

class FakeGain {
    readonly gain = new FakeParam();
    connect(): void {}
    disconnect(): void {}
}

interface FakeBuffer {
    duration: number;
}

class FakeSource {
    buffer: FakeBuffer | null = null;
    loop = false;
    onended: (() => void) | null = null;
    readonly starts: number[][] = [];
    readonly stops: number[][] = [];
    connected: FakeGain | null = null;
    connect(node: FakeGain): void {
        this.connected = node;
    }
    disconnect(): void {}
    start(...args: number[]): void {
        this.starts.push(args);
    }
    stop(...args: number[]): void {
        this.stops.push(args);
    }
    /** What the platform does when the audio clock reaches the stop time. */
    end(): void {
        this.onended?.();
    }
}

class FakeContext {
    currentTime = 0;
    readonly sources: FakeSource[] = [];
    private readonly durations = new WeakMap<ArrayBuffer, number>();
    createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }
    createGain(): FakeGain {
        return new FakeGain();
    }
    bytes(duration: number): ArrayBuffer {
        const bytes = new ArrayBuffer(8);
        this.durations.set(bytes, duration);
        return bytes;
    }
    async decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
        return { duration: this.durations.get(bytes) ?? 0 };
    }
}

/** A track's duration travels in its path: `a@45` lasts 45 s. */
const setup = () => {
    const ctx = new FakeContext();
    const graph = { ctx, musicBus: new FakeGain(), ensure: () => ctx } as unknown as WebAudioGraph;
    const music = new WebAudioMusicTransport(graph, () => {}, async (path) =>
        ctx.bytes(Number(path.split('@')[1])),
    );
    const load = async (id: TrackId, duration: number) => music.preload(id, `${id}@${duration}`);
    /** The source a track is playing on, and the two gains behind it. */
    const voice = (source: FakeSource | undefined) => {
        const handover = source?.connected;
        return { source, handover: handover?.gain };
    };
    return { ctx, music, load, voice };
};

const options = (after: TrackId, alignS = 7.5, fadeMs = 2000) => ({
    after,
    alignS,
    fadeMs,
    loop: true,
    volume: 0.8,
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a change on the beat', () => {
    it('starts the incoming track at the next multiple, from the same position', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 0.8 });

        ctx.currentTime = 10.2;
        void music.playAligned('b', options('a'));

        const [, b] = ctx.sources;
        // Position 10.2 s into a 7.5 s grid: the next line is 15 s, 4.8 s ahead.
        expect(b?.starts).toEqual([[15, 15]]);
        expect(b?.loop).toBe(true);
    });

    it('keeps the position of a track that was itself started on the beat', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await load('c', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10;
        void music.playAligned('b', options('a')); // b starts at 15, at position 15
        ctx.currentTime = 31;
        void music.playAligned('c', options('b'));

        // b is at 15 + (31 - 15) = 31 s: the next line is 37.5 s, 6.5 s ahead.
        expect(ctx.sources[2]?.starts).toEqual([[37.5, 37.5]]);
    });

    it('wraps the position into the incoming track when the two lengths differ', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 30);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 31;
        void music.playAligned('b', options('a'));

        expect(ctx.sources[1]?.starts).toEqual([[37.5, 7.5]]);
    });

    it('counts the loop seam as a line of the grid', async () => {
        const { ctx, music, load } = setup();
        await load('a', 40); // not a multiple of 7.5: the seam comes before 45
        await load('b', 40);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 80 + 38; // third turn, 38 s in
        void music.playAligned('b', options('a'));

        expect(ctx.sources[1]?.starts).toEqual([[120, 0]]);
    });

    it('skips a line too close to place a start on it, for the next one', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 7.49;
        void music.playAligned('b', options('a'));

        expect(ctx.sources[1]?.starts).toEqual([[15, 15]]);
    });

    it('lays both fades on the audio clock from that instant, and stops the outgoing at their end', async () => {
        const { ctx, music, load, voice } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 0.8 });
        ctx.currentTime = 10.2;
        void music.playAligned('b', options('a'));

        const a = voice(ctx.sources[0]);
        const b = voice(ctx.sources[1]);
        expect(b.handover?.events).toEqual([
            ['set', 0, 15],
            ['ramp', 1, 17],
        ]);
        expect(b.handover?.value).toBe(0);
        // The outgoing holds its level until the line, then fades.
        expect(a.handover?.events).toEqual([
            ['cancel', 10.2],
            ['set', 1, 10.2],
            ['ramp', 1, 15],
            ['ramp', 0, 17],
        ]);
        expect(a.source?.stops).toEqual([[17]]);
    });

    it('cuts on the line when there is no fade', async () => {
        const { ctx, music, load, voice } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10.2;
        void music.playAligned('b', options('a', 7.5, 0));

        const a = voice(ctx.sources[0]);
        const b = voice(ctx.sources[1]);
        expect(b.handover?.events).toEqual([]);
        expect(b.handover?.value).toBe(1);
        expect(b.source?.starts).toEqual([[15, 15]]);
        expect(a.handover?.events.at(-1)).toEqual(['set', 0, 15]);
        expect(a.source?.stops).toEqual([[15]]);
    });

    it('reads the audio clock, which stands still while the context is suspended', async () => {
        vi.useFakeTimers();
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10.2;
        // Twenty seconds of wall clock with the context suspended: the audio
        // clock has not moved, so neither has the position.
        vi.advanceTimersByTime(20_000);
        void music.playAligned('b', options('a'));

        expect(ctx.sources[1]?.starts).toEqual([[15, 15]]);
    });

    it('resolves once the outgoing track has ended, and gives its buffer back', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10.2;
        let done = false;
        const change = music.playAligned('b', options('a')).then(() => {
            done = true;
        });

        await Promise.resolve();
        expect(done).toBe(false);
        const a = ctx.sources[0];
        expect(a?.buffer).not.toBeNull(); // still fading out until 17 s

        a?.end(); // the audio clock reached 17 s
        await change;
        expect(done).toBe(true);
        expect(a?.buffer).toBeNull();
    });

    it('starts at once and from zero when nothing is playing', async () => {
        const { ctx, music, load } = setup();
        await load('b', 45);
        ctx.currentTime = 3.3;

        await music.playAligned('b', options('a'));

        expect(ctx.sources[0]?.starts).toEqual([[3.3]]);
    });

    it('takes the place of a change still waiting for its line', async () => {
        const { ctx, music, load, voice } = setup();
        await load('a', 45);
        await load('b', 45);
        await load('c', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10.2;
        void music.playAligned('b', options('a')); // b waits for 15 s
        ctx.currentTime = 11;

        await music.playAligned('c', options('b')); // resolves at once: b never sounded

        const [a, b, c] = ctx.sources;
        expect(c?.starts).toEqual([[15, 15]]);
        expect(b?.stops).toEqual([[]]);
        expect(b?.buffer).toBeNull();
        // a keeps the fade it already had.
        expect(a?.stops).toEqual([[17]]);
        expect(voice(a).handover?.events.at(-1)).toEqual(['ramp', 0, 17]);
    });

    it('changing back before the line keeps the track it never really left', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10.2;
        void music.playAligned('b', options('a'));
        ctx.currentTime = 11;
        void music.playAligned('a', options('b'));

        const [a, b, a2] = ctx.sources;
        // The old voice of a plays on and fades from 15 s; the new one enters
        // at 15 s from the very same position, so the two fades sum to a.
        expect(a?.stops).toEqual([[17]]);
        expect(a?.buffer).not.toBeNull();
        expect(b?.buffer).toBeNull();
        expect(a2?.starts).toEqual([[15, 15]]);
    });

    it('lets a stop reach a track that is still fading out', async () => {
        const { ctx, music, load } = setup();
        await load('a', 45);
        await load('b', 45);
        await music.play('a', { loop: true, volume: 1 });
        ctx.currentTime = 10.2;
        const change = music.playAligned('b', options('a'));

        await music.stop('a');

        await change; // resolved by the stop, not by the clock
        expect(ctx.sources[0]?.stops.at(-1)).toEqual([]);
        expect(ctx.sources[0]?.buffer).toBeNull();
    });
});

describe('a play made the ordinary way', () => {
    it('starts now, from the top, at its level, with the handover at unity', async () => {
        const { ctx, music, load, voice } = setup();
        await load('a', 45);
        ctx.currentTime = 4;

        await music.play('a', { loop: true, volume: 0.6 });

        const a = voice(ctx.sources[0]);
        expect(a.source?.starts).toEqual([[4]]);
        expect(a.handover?.value).toBe(1);
        expect(a.handover?.events).toEqual([]);
    });
});
