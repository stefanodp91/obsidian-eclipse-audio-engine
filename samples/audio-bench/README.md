# Audio-bench sample

A brand-agnostic reference sample that exercises every part of the engine a host would use, and
reports what the platform is doing while it does.

```bash
npm install
npm run dev
```

## What it exercises

| Control | What it proves |
| --- | --- |
| Autostart | Whether the platform allows audio before any gesture, and that a refusal is reported rather than hidden |
| Play, hard cut, crossfade | That replacing a track is a volume ramp and not a restart |
| Duck | That ducking is volume, so it behaves the same wherever the engine runs |
| Level | That a level change does not click, and that zero on every bus puts the hardware to sleep |
| Cue | A one-shot cue with volume and stereo position |
| Mute | That muting suspends the hardware instead of only zeroing a gain |
| Suspend and resume | What a host calls when the application leaves and returns to the front |

The status panel reports what `status()` returns — running, muted, the music transport in use and
the track currently playing — and the log records every call with its outcome, including errors
routed through the engine's error sink.

Every button is also a method on `window.__bench`, so the sample can be driven on a device over a
remote debugging connection without a finger on the screen.

## Regenerating the audio

The sample's three sounds are generated from numbers rather than committed as binaries nobody has
the source for: two four-second chords, so a crossfade has something to cross, and one short cue.

```bash
npm run assets --workspace @obsidian-eclipse/sample-audio-bench
```

This requires `ffmpeg` on the path. The loops are encoded as AAC in MP4 at 44.1 kHz and the cue as
lossless FLAC, which is how a host would ship them — the point of the sample is to exercise the real
path, and part of what this engine exists for lives in the container rather than in the samples.
