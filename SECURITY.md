# Security boundaries

## Backend boundary

Default runtime mode launches the genuine installed `zcode app-server`. That runtime owns authentication, provider requests, native tools, sandbox behavior, permission policy, and session storage. Workbench does not read or copy login stores, re-sign requests, spoof provider client identity, or silently switch to direct API access. The normal inherited process environment is available to the runtime and its own tools according to its policy.

Only use a trusted `zcode` on PATH or an absolute trusted launcher with `--runtime-path`. A malicious executable has your user permissions. No shell command fragments are accepted as the launcher option. Runtime output is terminal-control sanitized, but output, tools, and approval details remain untrusted.

Runtime diagnostics use a bounded in-memory ring buffer, terminal sanitization, and credential redaction. Startup failures show the latest meaningful diagnostic; `--debug-runtime` displays redacted records. Oversized records are dropped. No diagnostic files are saved. Redaction cannot recognize every arbitrary secret or private detail, so review output before sharing it.

The adapter requests guarded mode, including when resuming a session. This does not mean that every read, command, or write asks for permission: the runtime's own configuration and policy determine approval boundaries. Native permission requests receive one-time allow/deny answers only, never permanent rules. Noninteractive requests are denied. Unknown methods fail closed and unsupported structured input is cancelled. Runtime sessions may be persisted; Workbench makes no no-save guarantee for them. Closing the terminal does not delete native history.

Runtime access does not establish subscription entitlement or guaranteed access. Provider restrictions and limits still apply. Never use this adapter to evade an account or service restriction.

The sections below describe the separate direct API backend selected with `--backend api`. Its built-in file restrictions and environment allowlist do not apply to the runtime backend.

## Direct API trust model

Treat the model, repository files, remote responses, and subprocess output as untrusted. Tool arguments are validated locally. Approval is single-use and denied by default. A refusal is returned to the model as a tool error. Do not approve a replacement command that works around a refusal.

## File tools

File tools are restricted to the selected real workspace path. Traversal and symbolic links that escape it are rejected. Common secret locations and Git internals are blocked. This is not full secret detection. Source files can contain secrets; do not grant read access to sensitive projects unless you are authorized to transmit their contents.

File permissions and filesystem content can change concurrently. Use a workspace controlled only by you. Application checks cannot provide race-free confinement against another process changing the filesystem at the same time.

## Shell commands

There is no OS sandbox. Command approval authorizes arbitrary code running as your user. A command can read or change files outside the workspace, contact the network, invoke programs, or expose credentials from files. An environment allowlist reduces accidental credential inheritance but does not make a command safe. Review the full command and prefer a disposable isolated environment. Timeouts and cancellation are best effort; descendants or remote side effects may outlive a command.

## Network and data

Only the chosen API receives model requests directly from the application. Tool commands may create additional network connections. A custom endpoint receives the API key. Redirects are disabled. HTTP is accepted only for loopback testing. No telemetry is implemented.

Local session files retain plaintext conversation, including tool results and any sensitive data you supplied. The API key from configuration is not added to sessions, but pasted credentials cannot be automatically distinguished from normal text. Use `--no-save` when appropriate and secure your home directory.

## Reporting

Report a vulnerability privately to the repository owner before publishing reproduction details involving credentials or user data. Never include live credentials in issues or pull requests. Repository: https://github.com/Misbah-Engr/zai-cli.

## Runtime cancellation on Windows

The frontend requests cancellation through the native protocol. Forced shutdown on Windows guarantees termination of the launcher only; descendant processes may need to be stopped separately. On POSIX systems, the frontend also terminates its spawned runtime process group. Actions completed before cancellation are not rolled back.
