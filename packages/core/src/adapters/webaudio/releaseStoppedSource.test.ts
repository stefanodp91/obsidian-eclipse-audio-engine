// These tests hold one claim: when a transport stops a source, the source no
// longer holds its buffer. On iOS 26 a source stopped and disconnected in the
// same turn is never freed, and whatever buffer it still points at is freed
// with it — never (see `releaseStoppedSource.ts` for the measurement).
//
// The fake context records the order of the calls. The buffer has to be gone
// by the time the source is disconnected, because that is the moment WebKit
// stops looking at the node.

import { describe, expect, it } from 'vitest';
import { WebAudioMusicTransport } from './WebAudioMusicTransport';
import { WebAudioCueTransport } from './WebAudioCueTransport';
import type { WebAudioGraph } from './WebAudioGraph';
import type { AssetPath, TrackId } from '../../ports/driven';

class FakeParam {
    value = 0;
    cancelScheduledValues(): void {}
    setValueAtTime(): void {}
    setTargetAtTime(value: number): void {
        this.value = value;
    }
    linearRampToValueAtTime(): void {}
}

class FakeNode {
    constructor(protected readonly log: string[], protected readonly name: string) {}
    connect(): void {}
    disconnect(): void {
        this.log.push(`${this.name}.disconnect`);
    }
}

class FakeSource extends FakeNode {
    loop = false;
    private current: unknown = null;
    get buffer(): unknown {
        return this.current;
    }
    set buffer(next: unknown) {
        this.current = next;
        this.log.push(next === null ? `${this.name}.buffer=null` : `${this.name}.buffer=set`);
    }
    start(): void {}
    stop(): void {
        this.log.push(`${this.name}.stop`);
    }
}

class FakeContext {
    readonly sources: FakeSource[] = [];
    currentTime = 0;
    constructor(private readonly log: string[]) {}
    createBufferSource(): FakeSource {
        const source = new FakeSource(this.log, 'source');
        this.sources.push(source);
        return source;
    }
    createGain(): FakeNode & { gain: FakeParam } {
        return Object.assign(new FakeNode(this.log, 'gain'), { gain: new FakeParam() });
    }
    createStereoPanner(): FakeNode & { pan: FakeParam } {
        return Object.assign(new FakeNode(this.log, 'panner'), { pan: new FakeParam() });
    }
    async decodeAudioData(): Promise<object> {
        return { decoded: true };
    }
}

const fakeGraph = (ctx: FakeContext): WebAudioGraph =>
    ({
        ctx,
        musicBus: new FakeNode([], 'musicBus'),
        cueBus: new FakeNode([], 'cueBus'),
        ensure: () => ctx,
    }) as unknown as WebAudioGraph;

const fetchAsset = async (): Promise<ArrayBuffer> => new ArrayBuffer(8);
const track = 'track' as TrackId;
const path = 'track.m4a' as AssetPath;

describe('a stopped source gives its buffer back', () => {
    it('music: stop() drops the buffer before the source is disconnected', async () => {
        const log: string[] = [];
        const ctx = new FakeContext(log);
        const music = new WebAudioMusicTransport(fakeGraph(ctx), () => {}, fetchAsset);
        await music.preload(track, path);
        await music.play(track, { loop: true, volume: 1 });
        log.length = 0;

        await music.stop(track);

        expect(ctx.sources[0]?.buffer).toBeNull();
        // Two gains: the handover (unity unless a change on the beat is
        // running) and the level.
        expect(log).toEqual([
            'source.stop',
            'source.buffer=null',
            'source.disconnect',
            'gain.disconnect',
            'gain.disconnect',
        ]);
    });

    it('music: release() goes through the same stop', async () => {
        const log: string[] = [];
        const ctx = new FakeContext(log);
        const music = new WebAudioMusicTransport(fakeGraph(ctx), () => {}, fetchAsset);
        await music.preload(track, path);
        await music.play(track, { loop: true, volume: 1 });

        await music.release(track);

        expect(ctx.sources[0]?.buffer).toBeNull();
    });

    it('cues: releaseHold() drops the buffer of a held voice before it is disconnected', async () => {
        const log: string[] = [];
        const ctx = new FakeContext(log);
        const cues = new WebAudioCueTransport(fakeGraph(ctx), () => {}, fetchAsset);
        await cues.load(track, path);
        cues.hold(track, { volume: 1 });
        log.length = 0;

        cues.releaseHold(track);

        expect(ctx.sources[0]?.buffer).toBeNull();
        expect(log.slice(0, 3)).toEqual(['source.stop', 'source.buffer=null', 'source.disconnect']);
    });
});
