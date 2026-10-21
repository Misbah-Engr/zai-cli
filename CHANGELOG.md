# 0.1.3 integration preview

## 0.1.4

- Add native `/mode yolo` with explicit session-scoped confirmation and `/mode ask` to return to guarded runtime policy.
- Verify runtime mode acknowledgment; show YOLO / FULL ACCESS or MODE UNCONFIRMED rather than a stale local label.
- Keep configuration defaults, model selection, authentication, and native-stream restrictions unchanged.
- Reapply launch policy when opening or resuming a native session. Preserve mandatory runtime approval requests.
- Darken light-theme secondary controls and code. Add protocol, consent, persistence, and renderer regression tests.


- Accept upstream zcode-app-cli 3.15.3-37 with runtime 0.16.9, retaining explicit compatibility with 3.15.3-36.
- Recommend the upstream shared-OAuth repair and report the actual detected client version.
- Reject duplicate or conflicting version identity lines.
- Remove the unconditional re-login instruction from project_token_login_failed.
- Keep model flags, tool exclusions, credential ownership, and no-replay behavior unchanged.
- Live authenticated frontend recovery remains unverified. The upstream runtime is not bundled.

# Changelog

## 0.2.0 - Workbench integration preview

- Managed public runtime dependency and isolated-engine installers; normal launch is `zc`.
- Quiet native turns use session health checks and paginated completion recovery instead of an inactivity stop.
- Mouse caret positioning, drag selection, keyboard selection, undo/redo, explicit prompt history.
- Wheel/transcript navigation separated from editor arrows and prompt recall.
- Paged append-only visible transcript archive with search and full archived export.
- High-contrast light/dark palettes, terminal-aware auto theme, formatted tables, tool cards, and a bordered composer.
- Per-project last-session/model preferences, `zc resume`, `/status`, `/reconnect`, and in-interface `/login`.
- Local fixture-based validation only; live provider and target-platform release testing remain separate.

## 0.1.2 - 2026-10-19

Added an opt-in `zc stream` backend for the observed working headless account path
of zcode-app-cli 3.15.3-36 and zcode-runtime 0.16.9. It provides bounded NDJSON
projection, visible tool activity, exact explicit model selection, local display
history with scoped session resume, process cancellation, diagnostic suppression,
and local client-version checking. Authentication remains in the installed client.

The new backend is a guarded research preview, not approval-enabled editing or
strict read-only. It does not replace the legacy app-server adapter, repair its
missing credential callback, or silently switch existing configurations. Existing
direct API and demo paths remain available. Added 43 focused native-stream tests plus a package/CI version check, for 143
passing local tests. See the current validation record for the verification boundary.


## 0.1.1 - 2026-10-18

Native integration repair preview, not a working native-account release.

- Implement the runtime-preference reply for both inspected scopes with conservative feature settings.
- Add a model picker sourced from the actual runtime snapshot, with advertised reasoning levels and disabled-model reasons.
- Confirm model selection with the runtime. Do not guess a default or send a prompt before selection.
- Retain a blocked prompt as a draft and require explicit submission after model selection.
- Return schema-shaped unavailable responses for official MCP credentials and account-model authentication. No credentials are copied or synthesized.
- Make the missing account-authentication bridge visible in setup, help, diagnostics, and documentation.
- Add regression coverage for startup reverse requests, unavailable credentials, model catalogs, unavailable selections, and draft preservation.

The original frontend-only account-integration assumption was incomplete. The upstream app-server account-provider path requires the host to supply per-request authentication. This release does not implement that bridge and is not ready for native Coding Plan use.

## 0.1.0 - 2026-10-18

Initial preview release of ZC, an independently implemented terminal coding workspace by Striking Lions.

### Added

- Focused terminal interface with a fixed composer, multiline input, command palette, tool details, transcript scrolling, resize handling, and explicit approval dialogs.
- Dark, light, monochrome, and line-oriented modes. Offline demo with no model call or project-file edits.
- Direct Z.ai Chat Completions integration with streamed text and tool calls, bounded parsing, request timeouts, and limited pre-stream retries.
- Workspace file listing, numbered reads, literal search, approved file creation, exact hash-checked editing, and approved shell commands.
- Ask and read-only policies. Project trust is separate from individual action approval.
- Durable direct-backend sessions, branching resume, manual context compaction, and Markdown export.
- Experimental adapter for the source-inspected legacy ZCode Protocol v1 over stdio, using an existing upstream runtime.
- Local diagnostics, configuration, project guidance initialization, and cross-platform installation documentation.
- Dependency-free Node.js packaging, automated tests, a six-job GitHub Actions matrix, and a private-repository publishing script.

### Known limits

Live Z.ai requests, authenticated native-runtime compatibility, and actual Windows/macOS execution were not available in the local build environment. Automated provider and native tests use fixtures. CI definitions are supplied but have not run remotely. This is not a feature-complete replacement for Codex or Claude Code.
