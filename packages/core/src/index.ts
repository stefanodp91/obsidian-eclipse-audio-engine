// obsidian-eclipse-audio-engine — public surface.
//
// The engine owns the machinery: the graph, the buses, the safety limiter, the
// loop, the unlock, the application lifecycle, and one transport per platform.
// It owns no content and no policy — which file, and when, belongs to the game
// that plays it, exactly as models belong to the game rather than to a graphic
// engine.

export { createAudioEngine } from './api';
export type { CreateAudioEngineOptions } from './api';

export { WebAudioGraph } from './adapters/webaudio/WebAudioGraph';
export { WebAudioMusicTransport } from './adapters/webaudio/WebAudioMusicTransport';
export { WebAudioCueTransport } from './adapters/webaudio/WebAudioCueTransport';
export { localStorageMutePreference, inMemoryMutePreference } from './adapters/memory/mutePreference';
export { DefaultAudioEngine } from './application/DefaultAudioEngine';
export type { AudioEngineDeps } from './application/DefaultAudioEngine';

export type {
    AssetPath,
    AudioErrorSink,
    CueTransport,
    MusicTransport,
    MutePreference,
    TrackId,
} from './ports/driven';
export type { AudioEngine, AudioStatus, CueController, MusicController } from './ports/driving';
