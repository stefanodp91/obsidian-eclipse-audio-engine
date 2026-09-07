// The one bit the engine persists, and the smallest possible way to keep it.
//
// A host that already owns storage — a settings store, a native key/value
// bridge — should pass its own: this exists so `createAudioEngine()` works
// with no arguments, not because localStorage is a good place for state.

import type { MutePreference } from '../../ports/driven';

const KEY = 'obsidian-eclipse-audio.muted';

export function localStorageMutePreference(key: string = KEY): MutePreference {
    return {
        read(): boolean {
            try {
                return localStorage.getItem(key) === 'true';
            } catch {
                // Private mode, blocked site data, a preview frame: not knowing
                // the preference is not a reason to boot silent.
                return false;
            }
        },
        write(muted: boolean): void {
            try {
                localStorage.setItem(key, String(muted));
            } catch {
                /* quota or blocked storage: the session still honors it */
            }
        },
    };
}

/** For tests and for hosts that want the preference to live nowhere. */
export function inMemoryMutePreference(initial = false): MutePreference {
    let muted = initial;
    return {
        read: () => muted,
        write: (next) => {
            muted = next;
        },
    };
}
