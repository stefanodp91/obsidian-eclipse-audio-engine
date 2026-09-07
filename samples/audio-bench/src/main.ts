// audio-bench — the sample, and the instrument.
//
// It exercises every part of the engine a host would use, and it reports what
// the platform is *actually* doing while it does. That second half is the point:
// the defect this library was extracted from was invisible in code and obvious
// in `dumpsys`, so a sample that only made a noise would not have caught it.

import { createAudioEngine } from 'obsidian-eclipse-audio-engine';
import type { AudioEngine } from 'obsidian-eclipse-audio-engine';

declare global {
    interface Window {
        /** The bench's own handle, so a device can be driven over CDP without
         *  a finger: every button below is also a method here. */
        __bench?: Record<string, unknown>;
    }
}

// Music runs on Web Audio here, as it does on every platform this sample is
// opened on: a buffer decoded once and read in a circle has no seam at the loop
// point, which a queue-based platform player cannot offer. The measurement
// behind that, and the case in which a host should still bring its own
// transport, are in `packages/core/wiki/music-playback.md`.

const TRACKS = {
    a: { id: 'loop-a', path: 'audio/loop-a.m4a' },
    b: { id: 'loop-b', path: 'audio/loop-b.m4a' },
} as const;

const log: string[] = [];
const say = (line: string): void => {
    log.unshift(`${new Date().toISOString().slice(11, 23)}  ${line}`);
    const el = document.getElementById('log');
    if (el) el.textContent = log.slice(0, 40).join('\n');
};

const audio: AudioEngine = createAudioEngine({
    onError: (error, context) => say(`ERROR ${context.op}${context.id ? ` [${context.id}]` : ''}: ${String(error)}`),
});

async function refresh(): Promise<void> {
    const status = audio.status();
    const rows: Array<[string, string]> = [
        ['running', String(status.running)],
        ['muted', String(status.muted)],
        ['music transport', status.musicTransport],
        ['playing', status.playing ?? '—'],
    ];
    const el = document.getElementById('status');
    if (!el) return;
    // Built as nodes, not as a string. Some of these values come back across a
    // bridge, and a sample is code people copy: the version of this that
    // interpolated into innerHTML would be copied too.
    el.replaceChildren(
        ...rows.map(([key, value]) => {
            const row = document.createElement('div');
            row.className = 'row';
            const name = document.createElement('span');
            name.textContent = key;
            const reading = document.createElement('b');
            reading.textContent = value;
            if (value.includes('INVARIANT BROKEN')) reading.className = 'alarm';
            row.append(name, reading);
            return row;
        }),
    );
}

const actions = {
    async autoStart(): Promise<void> {
        const ok = await audio.tryAutoStart();
        say(ok ? 'autostart: allowed, audio is running with no gesture' : 'autostart: refused, waiting for a gesture');
        await refresh();
    },
    async playA(): Promise<void> {
        audio.unlock();
        await audio.music.play(TRACKS.a.id, TRACKS.a.path, { crossfadeMs: 0 });
        say('play loop-a (hard cut)');
        await refresh();
    },
    async crossfadeToB(): Promise<void> {
        audio.unlock();
        await audio.music.play(TRACKS.b.id, TRACKS.b.path, { crossfadeMs: 1500 });
        say('crossfade to loop-b over 1.5 s');
        await refresh();
    },
    async crossfadeToA(): Promise<void> {
        audio.unlock();
        await audio.music.play(TRACKS.a.id, TRACKS.a.path, { crossfadeMs: 1500 });
        say('crossfade to loop-a over 1.5 s');
        await refresh();
    },
    duck(): void {
        audio.music.duck(0.25, 1200);
        say('duck to 25% for 1.2 s — works on every transport because it is volume');
    },
    level(value: number): void {
        audio.music.setLevel(value);
        say(`music level ${value}`);
    },
    async cue(): Promise<void> {
        audio.unlock();
        await audio.cues.warm([{ id: 'cue', path: 'audio/cue.flac' }]);
        audio.cues.play('cue', { volume: 0.9, pan: Math.random() * 2 - 1 });
        say('cue (Web Audio on every platform)');
    },
    async stop(): Promise<void> {
        await audio.music.stop();
        say('stop');
        await refresh();
    },
    async mute(): Promise<void> {
        const next = !audio.status().muted;
        audio.setMuted(next);
        say(`muted = ${next}`);
        await refresh();
    },
    async suspend(): Promise<void> {
        await audio.suspend();
        say('suspended (what the host does when the app leaves the front)');
        await refresh();
    },
    async resume(): Promise<void> {
        await audio.resume();
        say('resumed');
        await refresh();
    },
    refresh,
};

window.__bench = { audio, ...actions };

document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
        const name = button.dataset['action'] as keyof typeof actions;
        const argument = button.dataset['arg'];
        const action = actions[name] as (arg?: number) => unknown;
        void action(argument === undefined ? undefined : Number(argument));
    });
});

// The boot sequence a host should copy: try without a gesture, and keep the
// gesture as a fallback rather than as the only way in.
void (async () => {
    if (!(await audio.tryAutoStart())) {
        say('autostart refused by the platform — the first tap anywhere will start it');
        const wake = (): void => {
            audio.unlock();
            say('unlocked by a gesture');
            void refresh();
            window.removeEventListener('pointerdown', wake, true);
        };
        window.addEventListener('pointerdown', wake, true);
    } else {
        say('autostart allowed: audio is running before anyone touched the screen');
        await audio.music.play(TRACKS.a.id, TRACKS.a.path, { crossfadeMs: 0 });
    }
    await refresh();
    setInterval(() => void refresh(), 2000);
})();
