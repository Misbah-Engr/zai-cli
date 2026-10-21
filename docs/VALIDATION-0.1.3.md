# Validation record

Release: ZC 0.1.3 integration preview. Date: 2026-10-19.

## Local verification

Linux x64, Node.js 22.16.0, npm 10.9.2. No authenticated ZCode client was present.
The original delivered 0.1.2 source was extracted and its 143 tests rerun before
editing. They passed.

The updated source passes **155 tests, zero failures, zero skips, zero cancelled**.
Syntax validation covers **40 JavaScript modules**. The version/help test now
uses the package's exported version instead of a stale literal.

Twelve new tests cover both explicitly accepted version pairs, preferred-client
metadata, CRLF, unlisted identities, duplicate identities, missing/oversized
version output, subprocess identity reporting, exact launch arguments and
process.env forwarding, no authentication retry, diagnostic suppression, and
the old-client update notice. Existing tests exercise streaming, persistence,
cancellation, package consistency, and terminal rendering.

Version 3.15.3-37 is reported by a synthetic fixture in the adapter tests. This
is NOT execution of that third-party release and does not establish protocol
compatibility with every message from it. No real login, token exchange, model
call, or live file read through the upstream runtime was tested here.

The upstream release record and merged PR 218 were inspected. The build
container could not resolve registry.npmjs.org, so actual installation or
execution of the 3.15.3-37 npm package was not tested. The frontend package does
not include it or modify its authentication source.

## Scope of this update

The frontend accepts client 3.15.3-37 alongside 3.15.3-36 with runtime 0.16.9.
It recommends the patched client and replaces the unconditional login advice.
Model arguments, guard policy, exclusions, child-process environment, credential
ownership, and no-prompt-replay behavior are unchanged.

A matched version pair is a local identity check, not an authentication or
executable-integrity check. The source-backed token-contract defect is relevant,
but has not been established as the cause of the user's latest failure.

## Packaging

The 0.1.3 frontend is packaged with npm pack and installed into a fresh local
prefix with lifecycle scripts disabled. Installed --version, --help, offline
demo, and a stream turn with the synthetic client are checked before delivery.
No registry publication, GitHub push, native Windows/macOS execution, or new
interactive pseudo-terminal test is claimed for this patch.

## Still unverified or unimplemented

Live account recovery on the user's server, long-lived credential renewal,
real 3.15.3-37 stream compatibility, live editing/approval support, an OS sandbox,
and end-to-end cross-platform operation remain unverified or unimplemented.
The guarded headless backend cannot provide ZC approval-enabled editing.

See [authentication recovery](AUTH-RECOVERY.md) and the retained
[0.1.2 record](VALIDATION-0.1.2.md) for the preceding test history.
