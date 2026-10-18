# Security boundaries

## Trust model

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
