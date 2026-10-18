# Z.ai Workbench

A lightweight terminal for your existing ZCode runtime. Version 0.2.0 uses the installed, unchanged `zcode-app-cli` app-server by default, with its existing login and provider configuration. It streams answers without starting the full ZCode TUI. It shows immediate activity, an elapsed waiting indicator in styled terminals, and reasoning activity without exposing private reasoning text. Raw runtime diagnostic logs are suppressed by default to avoid leaking sensitive data. Workbench is independent community software and is not affiliated with Z.ai.

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

## Runtime setup (default)

Install `zcode-app-cli` using its official instructions. Run `zcode` once and complete its own login and provider setup. If it already works in this terminal, there is no new key to configure in Workbench:

```sh
zai doctor
zai --cwd ./my-project
zai -p "Explain the architecture"
zai --resume NATIVE_SESSION_ID
```

Workbench starts `zcode app-server` as a subprocess and communicates over its native NDJSON protocol. It does not read, copy, decrypt, or reimplement runtime credentials, impersonate provider client headers, or issue model HTTP calls in runtime mode. The genuine runtime handles authentication and model requests. Account eligibility, subscription limits, and service policies still apply; using the runtime is not a guarantee of quota or access.

The model and provider default to the runtime's existing configuration. To explicitly select a configured model, use `--model PROVIDER/MODEL` with the runtime's exact provider and model IDs. This option does not rewrite the saved workspace default. API-specific environment variables are not used by Workbench's runtime frontend; the child process still inherits your environment and may interpret variables according to its own configuration.

Use `--runtime-path /absolute/path/to/zcode` only for a trusted installed launcher. It must be an absolute existing file. Never point this at a program supplied by an untrusted repository. This is executable selection, not a shell command string. Normal operation uses the installed `zcode` on PATH, so keep PATH trusted. On Windows, the adapter avoids executing command-shell shims. If automatic discovery fails, point to the official JavaScript launcher installed by npm:

```powershell
zai --runtime-path "$((npm prefix -g).Trim())\node_modules\zcode-app-cli\bin\zcode.js"
```

A `.js`, `.cjs`, or `.mjs` launcher is invoked with Node directly, with separate arguments and no shell interpolation. `.cmd` and `.bat` overrides are rejected. Paths with spaces remain a single argument when quoted as shown.

Runtime mode uses the runtime's `guarded` mode. The runtime decides which actions need approval, and it may allow some reads or actions without asking. Workbench displays native permission requests and accepts only one-time approvals; it does not grant permanent permission rules. Noninteractive permission requests are denied. Unknown interaction methods fail closed; structured user-input requests are cancelled rather than guessed. A task requiring an unsupported interaction may need to be continued in `zcode`.

Runtime storage, sandbox behavior, tool execution, context management, and permissions belong to ZCode. Workbench does not add an OS sandbox or impose the direct-API backend's file protections on native tools. Runtime sessions may be saved by ZCode. `--no-save`, `--allow-read`, `--max-tools`, `--profile`, and `--reasoning` are direct-API-only and are rejected in runtime mode. `zai sessions` currently explains how to manage native history in ZCode; use a known native ID with `--resume`. `doctor` reports local settings only and does not inspect authentication or test runtime/network connectivity.

No backend fallback is performed. A missing runtime, failed login, quota error, or protocol mismatch stops the request. The adapter currently targets ZCode Protocol 1; incompatible runtime versions fail with a protocol error.

## Direct API mode (explicit opt-in)

Use `--backend api` to select the original OpenAI-compatible Chat Completions implementation. It is independent of the runtime login. The optional Anthropic transport source module is not selected by the CLI. Choosing an endpoint or protocol does not by itself change account eligibility.

## Configure your API key

The CLI reads credentials from the environment and never writes the key to its configuration or prints it. Do not put credentials into prompts, repository files, or command-line arguments.

macOS and Linux, Bash:

```sh
read -rsp 'Z.ai API key: ' ZAI_API_KEY; echo
export ZAI_API_KEY
zai --backend api
```

Windows PowerShell:

```powershell
$secret = Read-Host 'Z.ai API key' -AsSecureString
$env:ZAI_API_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
zai --backend api
```

These examples set the key for the current terminal session. Use your operating system's secret manager for longer-lived credential management.

## Choose the right API profile

Within direct API mode, the Coding Plan endpoint is the default. Selecting it does not establish eligibility, guarantee subscription coverage, or bypass restrictions. There is no automatic fallback to the separately billed general API. You can override the profile with `--profile` or `ZAI_PROFILE`. Successful access still depends on your account and provider eligibility.

- `general` (explicit opt-in with `--profile general`): `https://api.z.ai/api/paas/v4`. Uses separately metered API credits. A Coding Plan subscription does not imply these calls are covered.
- `coding` (default): `https://api.z.ai/api/coding/paas/v4`. This is the documented OpenAI Chat Completions endpoint for Coding Plan. Z.ai restricts subscription benefits to officially supported tools. This independent CLI is not on that list. Verify eligibility with Z.ai before using this profile. Technical compatibility does not establish permission or guaranteed access.

The endpoint and billing notice are displayed before the first request. Read Z.ai's [supported tools and endpoints](https://docs.z.ai/devpack/tool/others) and [usage policy](https://docs.z.ai/devpack/usage-policy).

The default model is `glm-5.3-flash`, with high reasoning effort for a balance of depth and responsiveness. Use `--model glm-5.3 --reasoning high` for harder tasks, or `--reasoning max` for deeper work. Use `--reasoning low` when lower reasoning depth is an acceptable tradeoff for latency. Low reasoning does not disable model thinking. Model response speed depends on provider load and task complexity. Z.ai currently routes older `glm-4.7` requests to `glm-5.3-flash`; this CLI names the current model explicitly. Select a model available to your account with `--model MODEL` or `ZAI_MODEL`. Model availability and pricing can change.

## Direct API examples

```sh
zai --backend api --cwd ./my-project
zai --backend api -p "Explain how a binary search works"
zai --backend api --allow-read -p "Review the architecture in src"
zai --backend api --model glm-5.3-flash --max-tools 12
zai --backend api sessions
zai --backend api --resume SESSION_ID --cwd ./my-project
zai --backend api --no-save
zai --backend api doctor
```

`--allow-read` explicitly approves supported workspace reads and transmission of their results to the selected API for this invocation. Without it, each read asks. Writes and commands always require interactive approval. Noninteractive invocations cannot approve them and receive denied tool results instead. There is deliberately no unrestricted `--yes` mode.

`-p` runs one prompt and exits. Standard output contains model text; diagnostics, status, and approval prompts go to standard error. Noninteractive use requires `-p`; stdin is not implicitly uploaded. Exit status is 0 on success, 1 on errors, and 130 for a cancelled single prompt. Use `--plain` or `NO_COLOR=1` to disable color.

Interactive commands (both backends):

- `/help`: Show commands
- `/new`: Start a new conversation without deleting earlier sessions
- `/status`: Show the active backend settings and session ID
- `/exit`: Quit

End a line with a backslash to continue a multiline prompt. The terminal shows elapsed waiting time before the first streamed text. Ctrl+C cancels an active request or command. Actions already completed remain in place. Review the working tree before continuing.

## Direct API configuration

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

Both backends send prompts and tool context to their configured provider. The remaining storage and file-tool details below describe direct API mode only; runtime mode follows ZCode's own policies. Tool requests originate from a model and may be wrong. Repository instructions and command output are untrusted. Read permission is also permission to transmit the selected content to the provider.

Session JSON files contain conversation and tool output in plaintext. They are saved outside the project, with restrictive POSIX creation modes where supported. Windows access is governed by your user profile's ACLs. Use `--no-save` for sensitive sessions, or a secured `ZAI_HOME`. The program cannot stop you from pasting secrets in prompts or ordinary source files. Review what you share.

Built-in file operations enforce workspace boundaries and protect common credential paths and repository internals. These checks are defense in depth, not comprehensive secret detection or an OS security boundary. Approved shell commands run with your user's permissions and can access the network and files outside the workspace. Use a disposable container or a restricted OS account for untrusted repositories.

## Development

```sh
npm ci
npm run check
npm pack --dry-run
node src/cli.mjs --help
```

Tests use local mocks, mock runtime subprocesses, and temporary workspaces. They do not require or spend API credits. A live account smoke test still needs a valid key and an eligible endpoint. The source is organized into provider transport, agent loop, workspace tools, session storage, and terminal interface modules.

Model references: [Coding Plan overview](https://docs.z.ai/devpack/overview) and [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3).

Protocol references: [Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion), [Streaming Messages](https://docs.z.ai/guides/capabilities/streaming), and [Tool Integration](https://docs.z.ai/devpack/tool/others).

## License

MIT. Independent community software. Z.ai names and trademarks belong to their respective owners.
