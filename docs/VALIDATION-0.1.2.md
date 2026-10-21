# Validation record

Release: ZC 0.1.2 integration preview. Date: 2026-10-19.

## Observed local checks

Environment: Linux x64, Node.js 22.16.0, npm 10.9.2. Tests require no runtime npm
dependencies, API credentials, or upstream client installation. No authenticated
live provider was available in this build environment.

`npm run check` passed: **143 tests, 0 failures, 0 skips, 0 cancelled**.
The build syntax check covered **39 JavaScript modules**. This includes the older
99 tests plus 43 native-stream tests and one package/CI version consistency test.

New coverage includes NDJSON byte fragmentation, final lines without newlines,
malformed and oversized output, diagnostic suppression, duplicate-event handling,
main-session and turn identity checks, matching completion/result requirements,
nonzero exits after a seemingly successful result, failed authentication projection,
explicit model and policy flags, scoped local persistence, session locks, resume,
cancellation, idle timeouts, forced termination, and presentation boundaries.

Native stream tests launch a real Node subprocess implementing a **synthetic
fixture**. It does not call a model, read the real smoke file through ZCode, or
exercise real account tokens. The test strings and IDs are synthetic, not a
recording of the user's private session. No claim of live frontend authentication
is made from fixture results.

## Packaging

`npm pack` produced `striking-lions-zc-0.1.2.tgz`. Installation into a fresh isolated
npm prefix succeeded with install scripts disabled. The installed launcher printed
`0.1.2`. The installed offline demo completed successfully. The package retains
zero production npm dependencies and does not include the community client,
ZCode runtime, user credentials, user session logs, or active audit repositories.

## Terminal exercise

An actual POSIX pseudo-terminal launched the **installed** stream frontend with a
fixture runtime. The exercise approved workspace trust, submitted a prompt,
rendered the simulated tool/response, resized 120x32 to 80x24 and back, opened
model help, cancelled a pending turn, opened the session picker, and exited.

Observed exit code: **0**. Canonical input and echo were restored. No session lock
remained. This was not a real model connection and not a native Windows or macOS
test. The existing KeyDecoder treats a combined text-plus-newline input burst as
unbracketed paste, so the harness sends the text and Enter separately, like pasting
and explicitly pressing Enter. Paste itself must not submit a task.

Machine-readable results are in [validation-results.json](validation-results.json).
Earlier build records are retained in [VALIDATION-0.1.0.md](VALIDATION-0.1.0.md) and
[VALIDATION-0.1.1.md](VALIDATION-0.1.1.md).

## User-observed live baseline

The user supplied a successful headless run from October 19, 2026 using the account
model `account:zai-individual-coding-plan/GLM-5.3`, guarded policy, explicit tool
exclusions, and stream-json output. Its final records report success, one tool
call, two model requests, and the expected smoke-file text. The individual tool
call is outside the supplied tail, so the tail does not identify its exact tool
arguments. A separate earlier interactive screenshot did show a Read operation.

This supports the headless entry point for that run, not end-to-end validation of
the new frontend. The earlier account-token failure and later successful retry do
not establish that token refresh remains reliable over time.

## Remaining unverified or unimplemented

- Live account-backed prompts and tool activity through **ZC 0.1.2 itself**.
- Live multi-turn resume, cancellation, and long-session reliability through ZC.
- Native-stream execution on Windows, macOS, WSL, or other client-version pairs.
- Long-lived account renewal without reauthorization.
- Approval-enabled editing through the headless transport. This is **not implemented**.
- Strict read-only isolation or an OS sandbox. Neither is provided by this backend.
- The legacy app-server adapter's account-authentication bridge. It remains incomplete.
- Upstream session imports, manual stream compaction, rollback, standalone binaries,
  npm registry publication, or live GitHub Actions execution for this preview.

The CI workflow targets Linux, macOS, and Windows on Node 22.x and 24.x, and its
package filename was updated to 0.1.2 with a regression test. Those CI jobs have not
run remotely in this session. No GitHub push or release publication was performed
for this build. A local package is not the same as a published stable release.
