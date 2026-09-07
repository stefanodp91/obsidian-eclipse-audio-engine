# Audio assets

The engine owns no content: a host decides which files exist and when they play. What follows are
the requirements those files must meet, each with the measurement that produced it.

## Bitrate of music files

Encode music at **128 kbps**, or prove a lower rate with the phone's adaptive audio processing
switched on.

At 48 kbps the AAC encoder's noise floor sits about 21 dB under the signal. The music masks it until
a phone's adaptive processing — Adaptive Sound on Pixel devices — lifts quiet content, and the floor
comes up with it. Measured by ear on a device: 48 kbps scratches faintly, 128 kbps does not. The
file measures as clean either way, which is why this is written down rather than left to a check.

## Loop points

A track that loops must be encoded so that its loop is seamless: a whole number of cycles in the
loop length, and encoder delay and padding written honestly into the container. Web Audio reads the
decoded buffer in a circle and is sample-exact, so the container is the only place a seam can come
from. See [music playback](music-playback.md) for what happens when a platform player ignores that
metadata.

## Headroom

The graph ends in a safety limiter at **-4 dBFS**. It is a net, not a compressor that colors the
mix: below the ceiling nothing is touched.

It exists because Web Audio does not clamp. It passes floats through and the platform clips at the
final conversion, which sounds like a rasp and is invisible to every measurement made on the files
themselves. A mix of one music track and two normalized cues reaches full scale easily: cues
mastered at -3 dBFS are 0.708 linear apiece.

## Cues

Cues are short and must start immediately, so they are lossless (FLAC is a reasonable default) and
decoded up front through `cues.warm()`. A cue played cold is silent the first time. For a
once-per-session cue that can be the right trade, which is why warming is explicit rather than
automatic.

## Paths, and one platform trap

A host passes a path relative to the web assets root, such as `audio/bgm/menu.m4a`, and the engine
turns it into bytes with `fetch`. A host with a different asset pipeline replaces that with the
`fetchAsset` option.

The default fetch treats an **empty body**, not `response.ok`, as the failure. Measured on an
iPhone 13, 2026-09-07: every cue failed with `HTTP 0`. A Capacitor WKWebView serves the application
from a custom scheme, and a custom-scheme response can carry a perfectly good body with
`status === 0` — `ok` is false, and code that trusts it throws on a file that is right there. A host
with a real HTTP origin still gets a real error, because there a 404 arrives with a status that is
not zero.

## Latency

The context is created with `latencyHint: 'playback'`, the widest buffer.

`'interactive'` is the browser default and the most fragile: the smallest buffer the hardware
accepts, chosen to make a sound arrive as early as possible. On a phone that is also drawing a 3D
scene, that margin is the first thing to go, and the symptom is small scratches that no measurement
of the file can explain. `'balanced'` looked like the right compromise for a graph that carries both
music and cues, and was not enough: small scratches remained on a Pixel 9 Pro under load.

So the default is the widest margin, and cue responsiveness becomes something to verify rather than
assume. A host that lives on reactivity can pass `latencyHint` to `createAudioEngine()` knowing what
it is trading.
