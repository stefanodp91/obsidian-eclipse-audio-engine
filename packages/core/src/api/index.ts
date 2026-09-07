// The factory. One call, and the host has an engine that works on the web
// with no native anything.

import { DefaultAudioEngine } from '../application/DefaultAudioEngine';
import { WebAudioGraph } from '../adapters/webaudio/WebAudioGraph';
import { WebAudioCueTransport } from '../adapters/webaudio/WebAudioCueTransport';
import { WebAudioMusicTransport } from '../adapters/webaudio/WebAudioMusicTransport';
import { localStorageMutePreference } from '../adapters/memory/mutePreference';
import type { AssetPath, AudioErrorSink, MusicTransport, MutePreference } from '../ports/driven';
import type { AudioEngine } from '../ports/driving';

export interface CreateAudioEngineOptions {
    /** Turns a host-relative asset path into bytes. Defaults to `fetch`, which
     *  is right for a web build and for a Capacitor WebView alike. */
    fetchAsset?: (path: AssetPath) => Promise<ArrayBuffer>;

    /** Swap in a host-supplied transport, for a host whose content does not
     *  loop and which wants a platform media session. Left out, music plays
     *  through Web Audio, which is the right behavior on every platform for
     *  content that loops. */
    musicTransport?: (graph: WebAudioGraph, onError: AudioErrorSink) => MusicTransport;

    mutePreference?: MutePreference;

    /** How much buffer to ask the platform for: see `WebAudioGraph`. The
     *  default is `'playback'`, the widest margin. `'balanced'` looked like the
     *  right compromise and was not enough: on a Pixel 9 Pro, under the load of
     *  a 3D application, tiny scratches remained. A host that lives on
     *  responsiveness can ask for `'interactive'` knowing what it is trading
     *  away. */
    latencyHint?: AudioContextLatencyCategory;

    /** Where swallowed failures go. Defaults to a no-op, and a host that
     *  leaves it that way has chosen not to know. */
    onError?: AudioErrorSink;
}

/** **`response.ok` is not a readiness test for a bundled asset**, and getting
 *  that wrong makes a game silent on one platform only.
 *
 *  Measured on an iPhone 13, 2026-09-07: every cue failed with `HTTP 0 for
 *  audio/sfx/….flac`. A Capacitor WKWebView serves the app from a custom
 *  scheme, and a custom-scheme response can carry a perfectly good body with
 *  `status === 0` — `ok` is false, and code that trusts it throws on a file
 *  that is right there. Android never showed it, which is the whole shape of
 *  the problem: the check looked correct, and was wrong on the platform nobody
 *  was profiling that day.
 *
 *  So the test is the **body**: a zero status is accepted, and emptiness is the
 *  failure. A host with a real HTTP origin still gets a real error, because
 *  there a 404 comes back with a status that is not zero. */
const defaultFetch = async (path: AssetPath): Promise<ArrayBuffer> => {
    const response = await fetch(path);
    if (!response.ok && response.status !== 0) {
        throw new Error(`HTTP ${response.status} for ${path}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) throw new Error(`empty body for ${path}`);
    return bytes;
};

export function createAudioEngine(options: CreateAudioEngineOptions = {}): AudioEngine {
    const onError: AudioErrorSink = options.onError ?? (() => {});
    const fetchAsset = options.fetchAsset ?? defaultFetch;
    const graph = new WebAudioGraph(options.latencyHint ?? 'playback');

    return new DefaultAudioEngine({
        graph,
        music: options.musicTransport
            ? options.musicTransport(graph, onError)
            : new WebAudioMusicTransport(graph, onError, fetchAsset),
        cues: new WebAudioCueTransport(graph, onError, fetchAsset),
        mutePreference: options.mutePreference ?? localStorageMutePreference(),
        onError,
    });
}
