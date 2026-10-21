> Historical integration notes from the 0.1.x preview. Current setup and limitations are in [README](../README.md) and [COMPATIBILITY](COMPATIBILITY.md).

# Native adapter investigation and repair

Date: 2026-10-18. Patch: 0.1.1.

## Observed user failure

The user's live runtime requested `session/requestRuntimePreferences` and `interaction/requestOfficialMcpAuthHeaders`. ZC 0.1.0 rejected both as unsupported. Sending a prompt then produced "Select a model before continuing".

Inspection of the delivered source confirmed that its reverse-request handler implemented only permission requests. It also ignored the model catalog in the session settings and displayed "runtime default" when no model was selected. Its original fixture always supplied a model, so the tests did not exercise the actual first-launch failure.

## Implemented repair

The new preference handler replies with conservative settings for `runtime-materialization` and `user-execution`. It does not grant tool permissions. The catalog picker lists only runtime-advertised references, respects unavailable entries, and offers only advertised reasoning levels. Missing selection is explicit. A blocked prompt is not transmitted, and model selection does not automatically replay or submit it.

Official MCP credential requests now receive `{ ok: false, reason: "official_auth_unavailable" }`, with one notice per backend instance. This is an explicit failure, not successful MCP authentication. Account-provider credential requests receive `{ headersApplied: false, errorMessage: ... }`. Unknown capabilities still fail closed.

## Remaining release blocker

The native account-authentication bridge is not implemented. This is more than a test gap.

In the inspected upstream source, `createWorkspaceZCodeApp` supplies `createProviderRuntimeHeadersPort` when the caller supplies no alternate port. That port asks the host for authentication before account-model requests. Ordinary API providers and account providers are not the same path. ZC is currently the host for `app-server`, but does not implement that credential authority.

The actual terminal CLI uses a separate CLI provider-registry runtime and passes its `providerRuntimeHeadersPort` into the app. A future implementation should reuse the upstream account machinery through a verified integration path, retaining its refresh, scope, origin, cancellation, and token-handling rules. It should not make up provider IDs, scrape arbitrary token files, return fake successful headers, disable authorization, or silently switch to a paid API backend.

A working official CLI session would establish a baseline for the user's account. It would not by itself implement ZC's missing host bridge. Successful real inference, file reads, denied approvals, approved edits, cancellation, and resume through ZC are still required before native-account shipment.

## Primary source references

All source links below are pinned to `aac4755666d09fdcd70272fcf063c077a639015f`.

- [Protocol schemas: model options, settings, preferences, and credential responses](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/shared/src/zcode-protocol/index.ts)
- [Account-model reverse authentication port](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts)
- [Protocol workspace app assembly](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts)
- [Official MCP reverse authentication port](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts)
- [Terminal CLI prompt entry point](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/cli/src/prompt-command.ts)

The source protocol was inspected, but the user's installed release has not been reproduced locally. Automated regression tests use subprocess fixtures and do not establish live account access. The screenshots were taken through an SSH session; they do not establish native macOS execution of the agent.
