# Releasing

GitHub Releases and the GitHub Pages sample are deployed automatically from semantic-version tags.
The deployment workflow does not publish the package to npm.

## What earns a release

**A release must carry a runtime change.** Documentation, comments, release guides and repository
policy never become a version of their own: they wait on `main` and ship with the next patch that
changes behavior. A version that a consumer cannot act on still costs everyone who sees it a
decision — read the notes, bump the dependency, re-verify the build — and returns nothing.

`main` sitting ahead of the last tag is therefore the normal state, not a gap to close. The sibling
graphic engine paid for the opposite reading on 2026-09-08: a documentation-only patch was published
and then withdrawn, and withdrawing it meant rebuilding the artifacts of the version that absorbed
it, whose checksums no longer match the ones its consumers had pinned.

## Prepare a release

1. Choose the next version using semantic versioning.
2. Update the `version` field in the root manifest, the package manifest and the sample manifest.
3. Regenerate `package-lock.json` with a full `npm install` from an absent `node_modules`, so it
   records the same workspace versions **and every platform binary**. Do not use
   `npm install --package-lock-only` against an existing `node_modules`: npm then writes only the
   optional binaries for the current platform, the lockfile builds locally, and `npm ci` fails on
   the release runner with `Cannot find module @rollup/rollup-linux-x64-gnu`. Check the result with
   `grep -c '"node_modules/@rollup/rollup-' package-lock.json`, which must report every published
   variant rather than one.
4. Update the changelog when the release contains behavior changes.
5. Run `npm ci` followed by `npm run check` from a clean checkout.
6. Package a local candidate with
   `npm pack --workspace obsidian-eclipse-audio-engine --pack-destination <candidate-dir>` and
   archive the built sample. Record SHA-256 checksums separately from future official assets.
7. Smoke-test the actual tarball in a clean external consumer (exports, declarations and packaging).
8. Commit the version and changelog changes and merge them into `main`.

Preparation is local. Do not tag, push a release tag, start remote validation, or publish assets
without an explicit owner request for that action. If `npm run check` fails, preserve the failing
gate and report the blocker; a passing subset is not release approval. The sensitive-data gate scans
tracked content, including email literals in the checker itself. Git author metadata is outside that
content scan; never encode personal identities or address allowlists in source code.

An audio change that a listener would notice is not released on a passing build alone. Verify it on
a device with a single application producing sound — a listening verdict taken while a second
application is playing is void — and record the device and the date in the changelog entry.

## Publish a release

Create and push an annotated tag from the release commit:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

The `Deploy` GitHub Actions workflow then:

- verifies that the tag matches every workspace version;
- installs from the lockfile and runs the complete project checks;
- packages the npm tarball without publishing it to npm;
- packages the built audio-bench sample as a ZIP archive;
- generates SHA-256 checksums;
- creates a GitHub Release with automatically generated notes and attaches the artifacts;
- deploys the same tagged build to GitHub Pages after the release succeeds.

The jobs run in this order:

```text
validate-and-build -> publish -> deploy-pages
```

The separate `Validate` workflow runs the same repository checks only when the repository owner
starts it manually from GitHub Actions. Commits, pull requests and pushes to `main` do not start
validation or deployment workflows.

## Verify GitHub Pages

The `Deploy` workflow publishes GitHub Pages after it creates a successful GitHub Release. The site
is built from the same tagged commit as the release assets, so ordinary commits and pushes to `main`
never change the published sample.

After pushing a semantic-version tag, wait for the validation, release and Pages deployment jobs to
succeed, then open the published sample and confirm that it starts, plays, crossfades and reports a
running status.

If the workflow fails before publishing, fix the cause, delete the remote tag, recreate it on the
correct commit and push it again. Never move a tag after a successful public release; publish a new
patch version instead.
