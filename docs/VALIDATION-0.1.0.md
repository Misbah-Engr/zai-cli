# Validation record

Release: ZC 0.1.0. Date: 2026-10-18.

This document records observed local checks, not a declaration of universal compatibility. The final delivery includes a dependency-free npm package and the source used to build it.

## Local environment

Linux x64, Node.js 22.16.0, npm 10.9.2, Git 2.47.3. No live model key, authenticated official ZCode runtime, Windows host, macOS host, or authenticated GitHub CLI was available. The container could not download additional packages from the internet.

## Automated checks

Run `npm run check` from the source directory. The build validates every authored JavaScript module with `node --check`, verifies package entry points, and rejects prohibited punctuation in authored code and documentation. The test runner invokes an explicit list of test files without shell-glob dependence.

**Observed final result: 81 tests passed, 0 failed, 0 skipped.** Syntax validation covered 31 JavaScript modules. Documentation links and image references were checked.

The npm package installed successfully into an isolated prefix without external packages. The installed `zc --version` returned `0.1.0` with exit code 0. The installed offline demo completed with exit code 0. `zc doctor --json` returned exit code 1 and correctly identified that the separately installed native runtime was absent. This expected diagnostic result is not a live native connectivity pass.

The machine-readable local record is [validation-results-0.1.0.json](validation-results-0.1.0.json).

Coverage includes real temporary-file read/create/edit operations, approval denial, hash mismatch and concurrent changes, path traversal, symbolic and hard links, secret-path exclusion, read-only tool restrictions, bounded command output, process timeouts, cancellation, malformed streams, UTF-8 fragmentation, tool-argument assembly, interrupted-session recovery, redaction, compaction, and terminal state.

Provider tests use mocked HTTP responses, not live Z.ai inference. Native tests use a real child process implementing a fixture of the inspected protocol, not the official runtime. Passing those tests demonstrates local behavior under those fixtures only.

## Terminal smoke

An actual POSIX pseudo-terminal launched the CLI in demo mode. The observed exit code was 0. The exercise covered a multiline bracketed paste without premature submission, sending the draft, completion of the simulated response, opening the command palette, toggling tool detail, resizing from 120 x 32 to 80 x 24, and exiting.

Canonical input and echo were restored. Alternate-screen and bracketed-paste restoration sequences were emitted. This is one representative terminal exercise, not a claim that every terminal emulator interprets every sequence identically.

The PNG preview is rasterized from the real renderer's offline-demo frame. `node scripts/preview.mjs` reproduces the source frame. The PNG is not a screenshot of live inference or a claim of actual macOS execution.

## Package checks

The package is built with `npm pack`. Installation into an isolated npm prefix and execution of the installed launcher are checked locally before delivery. The archive is inspected for unexpected dependencies, local state, credentials, tests, and unrelated files.

A zero-dependency package does not imply that Node.js, operating systems, terminals, or the upstream runtime have no vulnerabilities. No live vulnerability-database scan or external security audit is claimed.

## GitHub status

The connected account was `Misbah-Engr`. A direct lookup of `Misbah-Engr/zcode-cli` returned 404 during the build. The connected actions did not expose repository creation or forking. No unrelated repository was modified. No GitHub push was completed.

The publisher script passed syntax validation and exited safely with code 1 when `gh` was missing. Its live repository-creation and push path has not been tested. The supplied CI workflow has six intended jobs across Windows, macOS, and Linux with Node 22.x and 24.x. None has run remotely during this delivery.

## Not verified

Live Z.ai inference, API quota and model entitlement, native account login, native subscription consumption, actual upstream end-to-end tool execution, protocol v4, native Windows/macOS execution, every terminal key sequence, standalone binaries, accessibility certification, and production-scale long-session performance remain unverified.

The direct API backend is the simpler path to validate with an actual API key. Keep the native adapter labeled experimental until its exact upstream build and account flow pass a live smoke test in a disposable repository.
