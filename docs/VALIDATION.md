# Validation record

## Post-validation macOS path repair

The original handoff later failed two path tests on the user's Mac. The source
now includes a canonical-root listing correction and six regression tests. The
patched suite passed all 235 tests on Linux, including a complete run with an
aliased TMPDIR. Native macOS revalidation remains pending. See
[MACOS-PATH-REPAIR.md](MACOS-PATH-REPAIR.md) for reproduction details and limits.

## Original rebuild validation (historical)

Release: ZC 0.2.0 integration preview. Date: 2026-10-20.

## What was executed

Local environment: Linux x64, Node.js 22.16.0, npm 10.9.2, Python 3, and a real
POSIX pseudo-terminal. The development frontend runs on that engine; the packaged
managed production runtime requires Node 24.14 or newer. The installer pins Node
24.22.0. No authenticated Z.ai account, real installed ZCode client, native Windows
host, or native macOS host was available in this build environment.

`npm run check` passed with **229 tests, 0 failures, 0 skips, 0 cancelled**.
The syntax/package check covered **53 JavaScript modules**. Tests use real local
files and subprocesses where applicable, but all provider/runtime responses are
synthetic. The test suite does not establish live inference or account renewal.

### Regression coverage

- Native silence triggers read-only session health queries instead of session/stop.
  Repeated quiet periods, pending approvals, unavailable health responses, idle
  ambiguity, matching completion recovery, and paginated recovery beyond 2,000
  events are exercised. Root-turn identity checks reject unrelated work.
- The editor covers selection and replacement, click positioning, word selection,
  drag ranges, wrapped/wide-character hit tests, undo/redo, and fragmented mouse
  reports. Arrow movement and wheel scrolling do not recall prompt history.
- The archive retains all 2,000 entries in a test exceeding the 400-entry screen
  working set. Reopen, duplicate streaming checkpoints, byte-bounded paging,
  export, ordinary secret redaction, incomplete-tail preservation, active-writer
  exclusion, and concurrent stale-lock reclamation are covered.
- Light/dark ordinary text roles are checked for calculated contrast of at least
  4.5:1 against their rendered backgrounds. Frame widths, selection rendering,
  Markdown tables, and fallback terminal sizes are tested. This is not a full
  accessibility audit or an emulator compatibility certification.
- Existing tool policy, explicit YOLO consent, mode acknowledgment, transport,
  cancellation, credential-free configuration, and direct-backend tests remain.

## Real terminal exercise with a synthetic runtime

Both the source frontend and an installed package were launched in a POSIX PTY.
The fixture is an actual child process implementing the inspected protocol; it
has no credentials, sends no HTTP request, and does not execute model tools.

The exercise passed with exit code 0. It submitted a bracketed paste only after
Enter, rendered a long synthetic answer, selected and deleted a prompt range
using mouse reports, exercised undo/redo, scrolled without changing the draft,
and kept a quiet active turn alive through multiple one-second health intervals.
Only an explicit Escape sent the stop request. Resizing 120x32 to 80x24 and back
retained the edited draft. Exit restored canonical input, echo, mouse reporting,
alt screen, bracketed paste, and archive locks.

The harness injects standard terminal reports. A user's terminal or tmux may
intercept keys, mouse reports, or clipboard requests before the application sees
them. OSC 52 operating-system clipboard delivery was not tested. `/mouse off`
and `/export` are fallbacks, not a claim of universal clipboard support.

## Package and installer verification

The npm frontend package was built and inspected. The real upstream dependency
could not be downloaded because registry DNS/network access was unavailable in
the container. A separately built **synthetic package named zcode-app-cli** was
used only to test dependency resolution and installed frontend execution. That
fixture package is not included in any release download.

The installed candidate printed version 0.2.0 and completed its offline demo.
The installed frontend passed the PTY exercise above. This does not establish
compatibility with the real dependency's production bytes.

`bash -n install/install.sh` passed. The POSIX installer transaction was then run
as an ordinary user, using an isolated temporary home with spaces/apostrophes,
the real local npm executable, the frontend package, and the synthetic dependency.
A pre-provisioned engine wrapper simulated only the installer's Node 24.22.0
version probe; actual JavaScript ran on Node 22.16.0. It did not download Node.

The installer test passed for staged installation, a working zc launcher, theme
preservation, managed-backend selection, PATH additions, retained previous
launcher/configuration, rollback after an injected launcher-switch failure,
rollback after an injected npm failure, unchanged synthetic upstream credential
sentinel, and removal of temporary install stages.

The PowerShell installer was reviewed but not executed: PowerShell and Windows
were unavailable. A real online first installation, Node archive verification,
public-registry dependency resolution, and signing/notarization were not tested.

## Renderer previews and local performance sample

`workbench-light.png` and `workbench-dark.png` rasterize the actual renderer's
frame using explicitly synthetic conversation/tool content. They were visually
inspected. They are not screenshots of live Z.ai execution or a Mac/Windows run.

One synthetic 400-message, 449,490-character rendering sample measured a cold
frame of 296.2 ms, cached median 5.9 ms, cached p95 10.2 ms, and process RSS around
90.4 MB in this container. These are local observations, not a performance SLA,
a comparison with another CLI, or an eight-hour stress test.

## Compatibility and remaining limits

The managed client dependency is pinned to zcode-app-cli 3.15.3-37 and resolved
through its published public bin. Its documented standalone authentication mode
is used by default. No private runtime bundle is imported or patched. Upstream
credential files are not parsed by ZC. Runtime libraries still follow upstream
transitive dependency ranges; no fully locked offline runtime distribution was
built here. The installer keeps the lockfile npm resolves for its release.

A GitHub Actions matrix is configured for Linux, macOS, and Windows with Node
24.14.0 and 24.x. Those remote jobs have not run. No GitHub push, npm publication,
code-signing certificate, or upstream approval is claimed.

Live account-backed tasks, native Windows/macOS installation, eight-hour jobs,
long-lived token refresh, and the user's exact tmux/Terminal interaction remain
unverified for 0.2.0. The repair removes the frontend's known stop-on-silence path;
it does not remove upstream failures or provide an OS sandbox. Explicit quit,
Escape, and reconnect can end a runtime process or task. It is not a detached
background job service. The legacy native-stream backend retains its own timeout
policy and is not the default.

The archive starts retaining what 0.2.0 actually receives. It cannot recreate
content already discarded by 0.1.x unless that content remains in an upstream
resume snapshot. Per-entry display limits and draft redaction remain documented
in the README. Failed/corrupt archive writes are reported rather than overwritten.
