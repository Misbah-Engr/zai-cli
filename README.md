# Z.ai Workbench

**A focused coding partner. In your terminal. On your terms.**

Z.ai Workbench is an independent, dependency-free Node.js CLI for working with Z.ai models. It streams answers, inspects a workspace with consent, proposes edits, and runs approved commands. A small interface keeps the conversation, permissions, and results visible.

```text
  Z.ai Workbench  /  0.1.0
  glm-5.3-flash  |  coding
  /your/project

you > Find the bug in the parser and add a regression test

  zai
  > read_file

Approval: Read src/parser.js
Allow once? [y/N]
```

## What works

- Interactive conversations and single-prompt automation
- Streaming text and incremental function-call assembly
- Workspace listing, literal text search, reads, writes, exact-match edits, and commands
- Per-action permission prompts with default denial
- Local sessions, workspace-bound resume, and an opt-out from saving
- Ctrl+C cancellation, request timeouts, bounded output, and per-turn tool budgets
- Plain terminal support, no runtime dependencies, and Node's native test runner

This is an initial release, not an affiliation with Z.ai or a claim of parity with established coding agents. It does not include an OS sandbox, MCP servers, IDE integration, automatic context compaction, or automatic rollback.

## Requirements

Install [Node.js 22 or newer](https://nodejs.org/en/download) and Git. Supported targets are macOS, Linux, and Windows PowerShell with Node installed. CI is configured for all three systems on Node 22 and 24. Remote CI must pass before claiming those jobs have been verified.

## Install

Repository: https://github.com/Misbah-Engr/zai-cli. This package has not been published to npm.

### macOS and Linux

```sh
git clone https://github.com/Misbah-Engr/zai-cli.git
cd zai-cli
npm ci
npm test
npm install --global .
zai --help
```

### Windows PowerShell

```powershell
git clone https://github.com/Misbah-Engr/zai-cli.git
Set-Location zai-cli
npm ci
npm test
npm install --global .
zai --help
```

An alternative on each system is:

```sh
npm install --global github:Misbah-Engr/zai-cli
```

Use an npm global directory writable by your user. Do not run the assistant with administrator or root permissions. If `zai` is not found, add npm's global binary directory to PATH or run `node src/cli.mjs --help` from the checkout.

To update a checkout: `git pull --ff-only`, `npm ci`, `npm test`, then `npm install --global .`. To uninstall: `npm uninstall --global zai-workbench-cli`. Local sessions remain until you delete them yourself.

## Configure your API key

The CLI reads credentials from the environment and never writes the key to its configuration or prints it. Do not put credentials into prompts, repository files, or command-line arguments.

macOS and Linux, Bash:

```sh
read -rsp 'Z.ai API key: ' ZAI_API_KEY; echo
export ZAI_API_KEY
zai
```

Windows PowerShell:

```powershell
$secret = Read-Host 'Z.ai API key' -AsSecureString
$env:ZAI_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
zai
```

These examples set the key for the current terminal session. Use your operating system's secret manager for longer-lived credential management.

## Choose the right API profile

Coding Plan is the default. No API credits are required by this configuration, and there is no automatic fallback to the separately billed general API. You can override the profile with `--profile` or `ZAI_PROFILE`. Successful access still depends on your account and provider eligibility.

- `general` (explicit opt-in with `--profile general`): `https://api.z.ai/api/paas/v4`. Uses separately metered API credits. A Coding Plan subscription does not imply these calls are covered.
- `coding` (default): `https://api.z.ai/api/coding/paas/v4`. This is the documented OpenAI Chat Completions endpoint for Coding Plan. Z.ai restricts subscription benefits to officially supported tools. This independent CLI is not on that list. Verify eligibility with Z.ai before using this profile. Technical compatibility does not establish permission or guaranteed access.

The endpoint and billing notice are displayed before the first request. Read Z.ai's [supported tools and endpoints](https://docs.z.ai/devpack/tool/others) and [usage policy](https://docs.z.ai/devpack/usage-policy).

The default model is `glm-5.3-flash`, with high reasoning effort for a balance of depth and responsiveness. Use `--model glm-5.3 --reasoning high` for harder tasks, or `--reasoning max` for deeper work. Use `--reasoning low` when lower reasoning depth is an acceptable tradeoff for latency. Low reasoning does not disable model thinking. Model response speed depends on provider load and task complexity. Z.ai currently routes older `glm-4.7` requests to `glm-5.3-flash`; this CLI names the current model explicitly. Select a model available to your account with `--model MODEL` or `ZAI_MODEL`. Model availability and pricing can change.

## Use it

```sh
zai --cwd ./my-project
zai -p "Explain how a binary search works"
zai --allow-read -p "Review the architecture in src"
zai --model glm-5.3-flash --max-tools 12
zai sessions
zai --resume SESSION_ID --cwd ./my-project
zai --no-save
zai doctor
```

`--allow-read` explicitly approves supported workspace reads and transmission of their results to the selected API for this invocation. Without it, each read asks. Writes and commands always require interactive approval. Noninteractive invocations cannot approve them and receive denied tool results instead. There is deliberately no unrestricted `--yes` mode.

`-p` runs one prompt and exits. Standard output contains model text; diagnostics, status, and approval prompts go to standard error. Noninteractive use requires `-p`; stdin is not implicitly uploaded. Exit status is 0 on success, 1 on errors, and 130 for a cancelled single prompt. Use `--plain` or `NO_COLOR=1` to disable color.

Interactive commands:

- `/help`: Show commands
- `/new`: Start a new conversation without deleting earlier sessions
- `/status`: Show model, endpoint, session ID, and permissions
- `/exit`: Quit

End a line with a backslash to continue a multiline prompt. The terminal shows elapsed waiting time before the first streamed text. Ctrl+C cancels an active request or command. Actions already completed remain in place. Review the working tree before continuing.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ZAI_API_KEY` | Required API credential, sent only as a bearer header |
| `ZAI_PROFILE` | `coding` by default; `general` requires explicit selection |
| `ZAI_MODEL` | Model ID; defaults to `glm-5.3-flash` |
| `ZAI_REASONING` | `low`, `high` (default), or `max` for GLM-5.2/5.3 |
| `ZAI_BASE_URL` | Optional OpenAI-compatible base URL, without `/chat/completions` |
| `ZAI_HOME` | Local session directory; defaults to `~/.zai-workbench` |
| `NO_COLOR` | Disable ANSI color |

A custom URL receives your API key and conversation. Only use a provider you trust. HTTPS is required except on loopback for testing. Redirects, URL credentials, query parameters, and fragments are rejected. Interactive custom endpoints require confirmation; explicitly setting the variable is consent in noninteractive mode.

## Privacy and security

Read [SECURITY.md](SECURITY.md) before granting command access.

Prompts, prior conversation, and approved tool results are sent to your configured provider. Tool requests originate from a model and may be wrong. Repository instructions and command output are untrusted. Read permission is also permission to transmit the selected content to the provider.

Session JSON files contain conversation and tool output in plaintext. They are saved outside the project, with restrictive POSIX creation modes where supported. Windows access is governed by your user profile's ACLs. Use `--no-save` for sensitive sessions, or a secured `ZAI_HOME`. The program cannot stop you from pasting secrets in prompts or ordinary source files. Review what you share.

Built-in file operations enforce workspace boundaries and protect common credential paths and repository internals. These checks are defense in depth, not comprehensive secret detection or an OS security boundary. Approved shell commands run with your user's permissions and can access the network and files outside the workspace. Use a disposable container or a restricted OS account for untrusted repositories.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
node src/cli.mjs --help
```

Tests use local mocks and temporary workspaces. They do not require or spend API credits. A live account smoke test still needs a valid key and an eligible endpoint. The source is organized into provider transport, agent loop, workspace tools, session storage, and terminal interface modules.

Model references: [Coding Plan overview](https://docs.z.ai/devpack/overview) and [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3).

Protocol references: [Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion), [Streaming Messages](https://docs.z.ai/guides/capabilities/streaming), and [Tool Integration](https://docs.z.ai/devpack/tool/others).

## License

MIT. Independent community software. Z.ai names and trademarks belong to their respective owners.
