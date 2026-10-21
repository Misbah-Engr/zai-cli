# Validation record

Release: ZC 0.1.4 native full-access preview. Date: 2026-10-19.

## Local verification

Linux x64, Node.js 22.16.0, npm 10.9.2. The supplied 0.1.3 source archive was the
starting point. The original 155 tests passed after the initial implementation.
The final source passes **191 tests, 0 failures, 0 skips, 0 cancelled**. Syntax
validation covers **42 JavaScript modules**. No runtime npm dependencies were added.

New tests cover mode mapping, runtime acknowledgment, live-setting precedence over
a lagging projection, denied/cancelled consent, pending/active work, ambiguous
mode-change failure, explicit guarded recovery, session identity, read-only
allowlist preservation, mandatory runtime interactions, mode reset on resume,
non-persistence in global configuration, source/backend routing, confirmation
labels, light-theme contrast, and persistent color/monochrome full-access labels.

Native protocol tests start a real child process implementing a synthetic fixture.
They exercise the actual ZC transport, backend, and presentation code. The fixture
is not the upstream runtime and does not make a live model call. The container
could not resolve registry.npmjs.org, so the actual community runtime package
could not be downloaded or executed here. No account credential was requested.

## Package and terminal

The frontend was packaged with npm pack and installed into a separate local prefix
using offline npm installation with lifecycle scripts disabled. Installed version
and help commands are checked. The installed package was exercised in a POSIX
pseudo-terminal with the synthetic runtime. It passed:

- default Enter declining YOLO, then explicit Right/Enter enabling it;
- a runtime-mandatory permission dialog remaining interactive while YOLO is active;
- returning to guarded mode in the same conversation;
- Escape declining another full-access request;
- resize and clean exit, with canonical input, echo, alternate screen, and bracketed-paste restoration;
- saved mode remaining ask throughout.

An initial terminal-check run detected a stale denial toast retained during the
next approval. The approval UI now clears the previous toast, with a regression
test. The subsequent installed-package terminal check passed with exit code 0.
This is not an authenticated live model or a native Windows/macOS test.

## Upstream source verification

The inspected upstream snapshot mapper derives settings.permission.mode and
settings.mode.current from app.getMode(), while session.mode can come from the
projection. The new adapter gives the live settings precedence and verifies that
the session identity and acknowledged mode match before displaying enabled status.
Source links are in FULL-ACCESS.md. They describe inspected source, not byte-for-byte
reproduction of the user's installed bundled runtime.

## Remaining boundaries

Live YOLO mode switching, unattended file edits, runtime-specific mandatory
approvals, and long-running autonomous jobs on the user's VPS have not been
verified with this release. User screenshots establish prior 0.1.3 native replies
and Bash execution, not 0.1.4 full-access execution. Windows/macOS CI jobs are
included but were not run remotely. No GitHub push or npm-registry publication
was performed for this build. The source archive and installable package are
conversation attachments.

YOLO is a session permission mode, not an OS sandbox or a proof of task completion.
Guarded mode may auto-allow routine operations. The native-stream backend remains
restricted; the direct API backend does not gain YOLO from this release. No upstream
runtime file, credential store, or authentication algorithm was edited.
