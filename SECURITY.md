# ZC security and execution boundaries

ZC is a terminal frontend, not an operating-system sandbox. An agent with tools runs under your user account. Use an unprivileged account and a disposable checkout for unfamiliar code. Model output, repository instructions, hooks, plugins, and tool results are untrusted inputs.

## Runtime ownership

The managed installation pins `zcode-app-cli` to 3.15.3-37 and launches its public `bin.zcode` through the isolated Node engine. ZC does not import private vendor modules, extract desktop binaries, copy token files, or construct replacement authentication headers. The community package contains the official agent runtime and its own compatibility layer. Its license notices remain in the installed dependency.

The native app-server uses standalone authentication unless an advanced launcher explicitly selects host mode. Native credentials, entitlement checks, model requests, sessions, plugins, and tool policy are owned by that runtime. Official MCP credential reverse requests and other unimplemented capabilities are rejected explicitly. A successful basic model request does not establish support for every desktop feature or MCP service.

## Consent and modes

Workspace trust names the workspace, backend, and destination. Trusting a folder is not tool isolation. Native `ask` maps to guarded runtime policy, which can auto-allow ordinary actions. Tool requests that reach the frontend receive one-time Allow/Deny controls with Deny selected initially. Paste and mouse clicking do not grant an approval by themselves; Enter confirms the selected choice. Escape denies a dialog.

`/mode yolo` is a session-specific, explicit full-access request. ZC verifies runtime acknowledgment before showing full access. Ambiguous acknowledgments block new prompts until guarded mode is reconciled. New connections and resume reapply their launch policy; YOLO is not saved globally. Read-only allowlists are not removed by an in-session escalation.

YOLO can change or delete files, execute programs, and access the network beyond the project folder. Mandatory runtime interactions and planning restrictions can still apply. It is neither a promise of unattended completion nor a guarantee that every action asks first.

## Quiet tasks and reconnect

The native frontend does not interpret missing events as permission to stop or repeat a task. Its quiet timer reads session state and event history. Completion must match the submitted root input or its turn identity. Unrelated background/subagent completions are not substituted for the active task. Health-check failure remains uncertain. An idle snapshot without matching completion requires inspection.

Escape, cancellation, explicit reconnect, and exit have process-lifecycle effects. Reconnect first closes the old connection and can cancel work owned by that runtime. It is intentionally not an automatic retry. A model call or tool might have executed before an RPC acknowledgment was lost. Review runtime state and changes before submitting a duplicate task.

## Local transcript and editor

Visible messages and displayed tool output are persisted to an owner-only append-only journal. Credential-shaped strings and known environment secrets are redacted, but pattern matching is not complete secret detection. Project text can itself contain confidential material. Do not publish the state directory or exports.

The journal index is built from records, while screen history loads bounded windows. Raw provider headers, authentication traffic, private model reasoning, and arbitrary stderr are not archived by this feature. Message and tool display limits are documented in the README. Active drafts show their actual text for accurate editing; saved drafts use redaction. Clipboard writes happen only after explicit Ctrl+C/Ctrl+X selection gestures. They use OSC 52 and depend on terminal policy. No clipboard reads occur automatically.

Symlinks at journal/lock files are rejected. An active writer's lock is not overridden. Corrupt/incomplete archive records stop archive writes with an error and preserve the original file. This does not harden the entire user-owned state directory against another malicious process with the same OS account. Keep a backup of important work.

Terminal control sequences from model/tool output are stripped before rendering. Grapheme-based editing handles tested emoji, combining marks, and wide characters; exact glyph widths still depend on terminal/font behavior. Bracketed paste is input text, not approval or submission.

## Installation

The installer downloads Node and the pinned npm runtime dependency over HTTPS. Node archives are checked against the distribution's checksum manifest; the frontend package is checked against its local release manifest when provided. npm verifies registry package integrity. These mechanisms do not replace signed release provenance or an external supply-chain audit.

The installers disable package lifecycle scripts, stage a new release in a user-owned location, validate the frontend/public runtime entry, retain a previous launcher/configuration backup, and then switch the launcher. They do not delete upstream credentials. System Node is not replaced. Failed upgrades can leave a retained engine/release directory but should not require account reset. First installation requires internet access. Transitive dependencies are recorded in the lockfile generated by that installation; this release is not a fully locked offline distribution.

The POSIX installer refuses root. Do not run the Windows installer as administrator. The optional PATH setup edits only user profiles or User PATH. It does not change system execution policy. Read the scripts before using them.

## Other backends

The legacy `native-stream` path cannot provide interactive ZC tool approvals. It applies explicit tool exclusions, but other runtime tools/plugins can still have side effects. It retains its earlier bounded idle/total-run behavior and is not the long-task backend introduced in 0.2.0.

The direct API backend has separate built-in file controls, exact-edit hash checks, secret-path exclusions, and approval-gated shell execution. Its read-only mode excludes all shell commands. Approved commands can operate outside those file-tool checks. Native tools do not inherit the direct backend's file restrictions. Redirects to a different API endpoint are not automatically followed.

## Reporting and validation

Remove secrets and private repository content from bug reports. Include the frontend version, runtime version, terminal type, operating system, and minimal redacted reproduction. Do not paste credentials, full authorization URLs, environment dumps, or raw authentication files.

See [docs/VALIDATION.md](docs/VALIDATION.md). Local fixtures exercise our integration logic, not live provider behavior, every terminal emulator, or long-term unattended reliability. No independent security audit or accessibility certification is claimed.
