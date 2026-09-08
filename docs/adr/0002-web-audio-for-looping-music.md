# ADR 0002: Web Audio for looping music on every platform

**Status:** accepted
**Date:** 2026-09-08

## Context

A host application plays the same music in a circle for minutes at a time. A platform media player
is built for content that ends, and the difference is not a matter of tuning: at every wrap of the
queue the decoder reconfigures, which is audible once per loop.

Three independent findings, each measured on a device, are recorded in
[music playback](../../packages/core/wiki/music-playback.md):

- a queue-based player produces a decoder event once per cycle of the track, matching the audible
  scratches from a 21.8 s track every 22 s to a 91 s track every 91 s;
- Android's `MediaPlayer` ignores the MP4 edit list, so each turn of a 48 s loop gains 32-42 ms of
  encoder priming;
- the compressed audio offload path renders a plain 44.1 kHz AAC stream with an audible rasp on at
  least one shipping device family, with a bit-identical file that measures as clean.

Three competing explanations — CPU load, the sum of concurrent cues, and the audio buffer size —
were each tested and eliminated.

## Decision

Music is decoded once and read from a buffer in a circle, on every platform, including inside a
Capacitor WebView on Android and iOS.

```mermaid
flowchart LR
    Track[Encoded track] --> Decode[Decoded once]
    Decode --> Buffer[Buffer source, looped]
    Buffer --> MusicBus[Music bus]
    MusicBus --> Master[Master gain]
    Master --> Limiter[Safety limiter at -4 dBFS]
    Limiter --> Output[Platform output]
```

Any implementation of `MusicTransport` must declare `gaplessLoop` honestly and must not request
compressed audio offload.

## Consequences

- Looping is sample-exact and independent of what a platform player does with encoder delay and
  padding.
- Crossfade, ducking and levels act on the same graph everywhere, so a control cannot exist on one
  platform only.
- The measured cost is accepted and published rather than hidden: +4.2 points of one core and +4.3%
  current in a paired ABBA comparison (n=2), and 18-35 MB of RAM per decoded track, one at a time.
- Features that belong to a platform media session — background playback, a media notification,
  lock-screen controls — are not provided by default. A host that needs them implements the driven
  port and takes the stated rules as its acceptance criteria.
- Music files must be encoded for a seamless loop and at a bitrate that survives a phone's adaptive
  audio processing. Both requirements, and their measurements, are in
  [audio assets](../../packages/core/wiki/audio-assets.md).

## Alternatives rejected

### Route music through the platform media player

Rejected on measurement: the seam at the loop point is the model of a queue-based player rather than
one of its settings, and a host that loops a track for minutes cannot live with it.

### Choose the transport per platform

Rejected because it reintroduces two behaviors under one API. It also makes every control a question
about where it is being run, which is the class of defect this package exists to prevent.

### Enlarge the buffer and keep the platform player

Rejected on measurement: raising the buffer from 250 ms to 1 s reduced the worst symptom without
removing it. A large buffer covers a stall, not a decoder discontinuity.
