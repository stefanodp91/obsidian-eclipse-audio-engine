# Music playback

**Rule.** Music is decoded once and read from a buffer in a circle. The engine does not hand a
looping track to the platform's media player, and an implementation of `MusicTransport` must not
request compressed audio offload.

A host application plays the same music in a circle for minutes at a time. That single requirement
is what separates this case from media playback, and it is where a platform player fails in three
independent ways. All three were measured on devices; each is stated here with the measurement,
because a rule without one gets reverted by the next reader who has a good reason.

## A platform player has a seam at the loop point

Measured on a Pixel 9 Pro against the same build on a Galaxy A25.

| track length | audible event | what is heard |
| --- | --- | --- |
| 21.8 s | every 22 s | frequent scratches |
| 91 s | every 91 s | sporadic scratches |
| two tracks overlapping | two decoder starts | the worst case |
| ~48 s under a dense cue load | every 48 s | present, but covered by the cues |

One mechanism explains the whole table, and the platform log names it — one event per cycle of the
track:

```text
c2.android.aac.decoder#385:1D-Output: received null buffer
MediaCodec: keep callback message for
CCodecConfig: query failed after returning
```

The queue moves from one item to the next and the AAC decoder reconfigures. This is the model of a
queue-based player, not one of its settings, and no option removes it.

### What it was not

Three hypotheses each held for a few hours and fell. They are recorded because they are the ones the
next reader will have:

- **not load**: zero mixer underruns across a full session, and no frame gaps above 60 ms during the
  transitions that scratched the most;
- **not the sum of the cues**: the densest passage, with tens of cues per second, is the cleanest
  place of all;
- **not the buffer**: raising it from 250 ms to 1 s reduced the worst symptom without removing it,
  because a large buffer covers a stall, not a decoder discontinuity.

A system feature — Adaptive Sound on Pixel devices — amplified everything, which is why the same
build sounded different on two phones. With the artifact removed it has nothing left to amplify, and
the build is clean with that feature switched on.

## A platform player's loop is not gapless

Android's `MediaPlayer` ignores the MP4 edit list, so every turn of a 48 s loop gains 32-42 ms of
encoder priming: a hiccup once per loop. It is measurable without a device, by decoding the file
with `ffmpeg -ignore_editlist 1` and comparing the result with the honest decode.

A Web Audio buffer source is sample-exact by construction. `MusicTransport` therefore carries a
`gaplessLoop` flag: a transport that cannot loop cleanly must say so instead of being trusted.

## Compressed audio offload renders some streams with a rasp

On Android the offload path decodes AAC on a coprocessor to save power. On at least one shipping
device family it renders a plain 44.1 kHz AAC stream with an audible rasp — measured 2026-09-07 on a
Pixel 9 Pro against a Galaxy A25 with the same build and the same bit-identical file, by switching
transports at runtime inside one running application, three times.

The file was innocent: peaks 6-9 dB below full scale, zero mixer underruns, bytes in the installed
package matching the source. In Media3 offload is opt-in, so the requirement costs nothing — but it
has to be stated, or it gets enabled later for the battery win and reopens this.

## What the decision costs

Decoding once and reading from a buffer is not free, and the price is stated so a host can weigh it:

- **+4.2 points of one core and +4.3% current**, paired ABBA comparison, n=2;
- **18-35 MB of RAM per decoded track**, one track at a time.

## When a host should still bring its own transport

The reasoning above is about content that loops. A host that plays content which *ends* — a stinger,
a scene, a spoken chapter — does not meet the condition that makes a platform player fail, and gains
what a platform player offers: background playback, a media notification, lock-screen controls, and
hardware decoding for long files.

That host injects its own implementation through the `musicTransport` option of
`createAudioEngine()`. The port is public for exactly this reason, and the rules above become its
acceptance criteria: declare `gaplessLoop` honestly, and do not request compressed audio offload.
