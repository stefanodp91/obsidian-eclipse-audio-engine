# Credits and third-party software

Obsidian Eclipse Audio Engine is original software distributed under the repository's
[MIT License](LICENSE). It builds on the open-source projects below. Each project remains subject to
its own copyright and license terms.

## Runtime

The published package has **no runtime dependency and no peer dependency**. It speaks the
[Web Audio API](https://www.w3.org/TR/webaudio/), a W3C standard implemented by the browser or
WebView that hosts the application.

## Development toolchain

These projects build, type-check and test the package. They are development dependencies and are not
distributed with it.

- [TypeScript](https://www.typescriptlang.org/), licensed under the Apache License 2.0 —
  [source repository](https://github.com/microsoft/TypeScript).
- [Vite](https://vite.dev/), licensed under the MIT License —
  [source repository](https://github.com/vitejs/vite).
- [Vitest](https://vitest.dev/), licensed under the MIT License —
  [source repository](https://github.com/vitest-dev/vitest).

## Sample assets

The audio-bench sample generates its own sounds from numeric definitions with
[FFmpeg](https://ffmpeg.org/), which is invoked as an external tool during development and is neither
bundled nor redistributed here. The sample contains no downloaded audio, music, or third-party
recordings.

## Related projects

The [Obsidian Eclipse Graphic Engine](https://github.com/stefanodp91/obsidian-eclipse-graphic-engine)
is the sibling repository, built on the same boundary between library and host. It is not a
dependency of this package, and this package is not a dependency of it.

## Dependency records

The exact resolved versions and declared licenses for the complete dependency graph are recorded in
[`package-lock.json`](package-lock.json).
