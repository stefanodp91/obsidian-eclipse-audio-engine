#!/usr/bin/env node

// The sample's audio, generated from numbers rather than committed as binaries
// nobody has the source for. Two loops so a crossfade has something to cross,
// and one cue.
//
// They are encoded exactly the way a host would ship music — AAC in an MP4 at
// 44.1 kHz for the loops, lossless FLAC for the cue — because the point of this
// sample is to exercise the real path, and half the defects this library exists
// for live in the container rather than in the samples.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'audio');
mkdirSync(out, { recursive: true });

const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);

/** A chord that loops cleanly: whole numbers of cycles in the loop length. */
const chord = (name, freqs, seconds) => {
    const inputs = freqs.flatMap((f) => ['-f', 'lavfi', '-i', `sine=frequency=${f}:duration=${seconds}`]);
    const mix = `amix=inputs=${freqs.length}:normalize=0,volume=${(0.5 / freqs.length).toFixed(3)},` +
        `afade=t=in:st=0:d=0.02,afade=t=out:st=${(seconds - 0.02).toFixed(3)}:d=0.02`;
    ffmpeg([...inputs, '-filter_complex', mix, '-ac', '2', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
        join(out, `${name}.m4a`)]);
    console.log(`  ${name}.m4a  ${seconds}s  ${freqs.join(' + ')} Hz`);
};

chord('loop-a', [220, 277.18, 329.63], 4);
chord('loop-b', [196, 246.94, 293.66], 4);

ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.12',
    '-af', 'volume=0.6,afade=t=out:st=0.02:d=0.1', '-ac', '1', '-c:a', 'flac',
    join(out, 'cue.flac')]);
console.log('  cue.flac   0.12s  880 Hz');
