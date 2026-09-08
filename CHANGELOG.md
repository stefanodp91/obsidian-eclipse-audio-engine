# Changelog

All notable changes to this repository are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/stefanodp91/obsidian-eclipse-audio-engine/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stefanodp91/obsidian-eclipse-audio-engine/releases/tag/v0.1.0
