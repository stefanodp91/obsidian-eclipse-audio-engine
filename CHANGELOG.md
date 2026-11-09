# Changelog

All notable changes to this repository are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-09

### Added

- A change of track on the beat. `music.play(id, path, { alignS, crossfadeMs })` waits for the next
  instant at which the playing track's position — time since its start, modulo its duration, on the
  `AudioContext` clock — crosses a multiple of `alignS` seconds (the loop seam counts as one), starts
  the new track there from the same position modulo its own duration, and runs the crossfade from
  that instant. Two tracks of the same length and tempo stay on the beat across the change. The
  position stands still while the context is suspended. The transport performs the change through
  a new optional `MusicTransport.playAligned(id, { after, alignS, fadeMs, loop, volume })`, which
  `WebAudioMusicTransport` implements by scheduling the start, both fades and the stop on the audio
  clock in one turn. A transport without it gets the ordinary crossfade; a grid that is not a finite
  positive number is ignored; with nothing playing the track starts at once from zero. While a
  change waits for its line, `music.stop()` and `music.duck()` reach the track still sounding, and
  an ordinary change fades it out. See `packages/core/wiki/music-playback.md`.

### Changed

- Each Web Audio music voice carries a second gain, at unity unless a change on the beat is fading
  it, so the change never fights a level or a duck. A `play` without `alignS` sounds as before; a
  host's own transport keeps compiling, since the new port member is optional.

### Known limitations

- Not yet verified by ear on a device. Unit tests cover the scheduling (line, offset, fades, stop,
  suspension, fallback); the listening check the release guide requires is still to be done.

## [0.1.1] - 2026-09-22

### Fixed

- A stopped music track gives its decoded buffer back on iOS 26. WebKit never frees an
  `AudioBufferSourceNode` that is stopped and disconnected in the same turn, together with the buffer
  it points at: a host changing track at every screen leaked one decoded track per change, and on an
  iPhone 13 the web content process was killed after 60-71 changes of a 17.6 MB track. The music
  transport's `stop()` and the cue transport's `releaseHold()` now set the source's buffer to `null`
  before disconnecting it; the measurement is in `packages/core/wiki/music-playback.md`. The change is
  not audible by design: the buffer is dropped from a source that is already stopped. Verified on an
  iPhone 13 with iOS 26 on 2026-09-22 in a host application: thirty consecutive full sessions with the
  same stop behavior in place, against a kill at the eighteenth without it.

### Changed

- State in the release guide that a release must carry a runtime change. Documentation, comments and
  repository policy wait on `main` and ship with the next patch that changes behavior, so `main`
  ahead of the last tag is the normal state rather than a gap to close. This entry is itself
  documentation, and stays here by its own rule.

## [0.1.0] - 2026-09-08

### Added

- Initial release of `obsidian-eclipse-audio-engine`: the audio graph (music and cue buses behind a
  safety limiter at -4 dBFS), unlocking by gesture and by autostart where the platform allows it, a
  Web Audio music transport with a sample-exact loop, a Web Audio cue transport with one-shots and
  held voices, and an application layer that builds crossfade, ducking, bus levels and the dormant
  state once, so they behave identically on every host.
- `createAudioEngine({ fetchAsset, musicTransport, mutePreference, latencyHint, onError })`, with
  `latencyHint` defaulting to `'playback'`.
- `samples/audio-bench`: a brand-agnostic reference sample whose three sounds are generated from
  numeric definitions, and which reports what the platform is doing while the engine runs.
- Repository documentation: architecture, engine lifecycle, music playback and audio assets, plus
  two architecture decision records and a release procedure.

### Known limitations

- iOS behavior is exercised through a host application rather than by the sample, which has no
  Xcode project of its own.
- The cost of decoding music into a buffer is measured on one device and one host application: +4.2
  points of one core and +4.3% current in a paired ABBA comparison (n=2), and 18-35 MB of RAM per
  decoded track.

[Unreleased]: https://github.com/stefanodp91/obsidian-eclipse-audio-engine/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/stefanodp91/obsidian-eclipse-audio-engine/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/stefanodp91/obsidian-eclipse-audio-engine/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stefanodp91/obsidian-eclipse-audio-engine/releases/tag/v0.1.0
