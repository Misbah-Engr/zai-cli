# Validation record

Release: ZC 0.1.1 integration preview. Date: 2026-10-18.

## Scope and outcome

Native account authentication is not implemented. This patch is not a working native Coding Plan release. It repairs startup-preference handling and model selection, and reports credential-bridge failures explicitly. See [native repair notes](NATIVE-REPAIR.md).

## Observed checks

Local environment: Linux x64, Node.js 22.16.0, npm 10.9.2.

`npm run check` passed: 99 tests, 0 failures, 0 skips. Syntax validation covered 34 JavaScript modules. The existing direct-provider, file-tool, permission, stream, process, and terminal tests were rerun, alongside 18 added regression tests.

New coverage includes startup reverse requests arriving before the session-create response, both preference scopes, conservative preferences without approvals, missing-model transmission blocking, actual-reference model catalog selection, explicit reasoning levels, unavailable models, invalid references, model-catalog limits, authoritative current selection, explicit credential unavailability, deduplicated notices, draft retention, disabled picker entries, and non-ready account-authentication diagnostics.

An actual POSIX pseudo-terminal launched ZC with a subprocess fixture, showed the startup model picker, selected a fixture model with an advertised reasoning level, accepted an unsent draft, resized from 120 x 32 to 80 x 24, and exited with code 0. Alternate-screen and bracketed-paste restoration sequences were emitted, and the unsent draft was saved. This was a fixture-backed UI smoke test, not a live model request.

The npm archive installed into an isolated user-owned prefix with npm offline mode. The installed launcher returned version 0.1.1 and the installed offline demo exited with code 0. No registry publication or GitHub push was performed.

Machine-readable results: [validation-results.json](validation-results.json). Historical first-release results: [VALIDATION-0.1.0.md](VALIDATION-0.1.0.md).

## Not established by these checks

No authenticated official ZCode binary was exercised here. The user's installed release was not reproduced locally. No live provider inference, subscription access, provider-header refresh, official MCP authentication, actual Windows/macOS execution, or remote CI run is claimed. The credential callbacks deliberately return failure, not fake success.

A successful official-CLI baseline does not complete the missing ZC account-host bridge. Real inference, tools, denied and approved edits, cancellation, and resume through ZC still need end-to-end validation after that implementation.
