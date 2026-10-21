> Historical integration notes from the 0.1.x preview. Current setup and limitations are in [README](../README.md) and [COMPATIBILITY](COMPATIBILITY.md).

# Account-backed native stream preview

Version 0.1.3. Prefer upstream 3.15.3-37 for its shared-OAuth repair. Version 3.15.3-36 remains accepted with a warning. See [authentication recovery](AUTH-RECOVERY.md). This is an opt-in guarded research integration, not a stable full coding release.

## What the user's result established

The user supplied a successful headless run on October 19, 2026 after a fresh
client authorization. Its tail contains a successful `turn.completed` event,
a matching final `result` object, the expected `ZC_NATIVE_FILE_READ_OK` response,
one runtime-reported tool call, and two provider model requests. The earlier
individual tool event was not in the supplied tail, so that tail alone does not
independently identify the tool or its arguments. The separate earlier interactive
screenshot did show a Read operation on the smoke file.

The observed run used zcode-app-cli's explicit account model and guarded policy.
It demonstrated live headless inference for that account at that time. It did not
establish long-term token refresh reliability, arbitrary model entitlement, exact
file-read semantics for other repositories, or this frontend's end-to-end behavior.

## Entry point

This adapter starts a new process for every explicitly submitted prompt:

```text
zcode --model <provider/model> --mode guarded
  --disallowedTools Bash,Write,Edit,NotebookEdit,Task,Agent,CreateWorkflow,AmendWorkflow
  --output-format stream-json [--resume <known-upstream-session-id>]
  --prompt <literal-prompt-argument>
```

There is no shell interpolation, response-protocol proxy, automatic login, or
fallback to a direct API. The process inherits the normal client environment.
The client handles its own provider credentials, refreshes, retries, and stored
sessions. ZC itself does not replay submitted prompts after errors. Provider-internal
retry policy remains owned by the installed client and may perform request retries.

Before connecting, the preview checks `--version`. The preferred pair is:

```text
zcode-app-cli 3.15.3-37
zcode-runtime 0.16.9
```

Client 3.15.3-36 with runtime 0.16.9 is also accepted with an update notice.
An unlisted client or runtime is rejected, not declared compatible based only on a
similar product name. Version matching is a compatibility check, not executable
integrity verification. Only run a client executable you trust.

## Install and launch

The package remains dependency-free and does not replace `zcode`.
Download `striking-lions-zc-0.1.3.tgz` onto the machine that will install it.
For an SSH server, transfer the file there first. A chat attachment is not a public
HTTP URL and is not automatically available in the remote home directory.

macOS, Linux, or WSL with a suitable Node installation:

```bash
npm install --global --prefix "$HOME/.local" ./striking-lions-zc-0.1.3.tgz
export PATH="$HOME/.local/bin:$PATH"
zc stream --model 'account:zai-individual-coding-plan/GLM-5.3' --cwd /path/to/test/workspace
```

With an older system Node, leave it untouched and use Node 24 for this process:

```bash
npx --yes --package=node@24 -- npm install --global \
  --prefix "$HOME/.local" ./striking-lions-zc-0.1.3.tgz
export PATH="$HOME/.local/bin:$PATH"
npx --yes --package=node@24 -- zc stream \
  --model 'account:zai-individual-coding-plan/GLM-5.3' \
  --cwd /path/to/test/workspace
```

Windows PowerShell, for the frontend itself:

```powershell
npm.cmd install --global .\striking-lions-zc-0.1.3.tgz
zc.cmd demo
```

The native-stream backend has not been tested against the real Windows or macOS
client. It needs the exact client-version pair and an executable or supported Node
wrapper path that can be spawned without shell interpolation. Do not supply a
`.cmd` shim as a protocol executable. Native Windows stream use is not advertised
as validated just because the frontend installs. WSL is an intended Linux runtime
path but was not tested here either.

The shown account model is an observed example, not a default selected by ZC.
Use the exact provider/model available to your own account.

## What appears in the UI

Text deltas become the normal assistant response, and tool lifecycle events become
tool cards. The final text reconciles with its streaming message rather than being
appended a second time. Summarized integer usage fields populate the status row.
Raw `session.updated` telemetry, reasoning text, headers, exception stacks, and
stderr do not enter the visible transcript or stream-session store.

This filter does not make model text or Read results secret-free. Do not ask the
agent to read credential files. File-tool access policy belongs to the upstream
runtime. Model prompts are passed as process arguments, so avoid putting secrets
in them. The per-prompt limit is 24,000 UTF-8 bytes.

## Permissions and tool availability

The stream backend only supports guarded mode with the explicit denylist above.
It refuses `--mode ask` and `--mode read-only` rather than weakening their meanings.
Those eight blocked tool names do not form a read-only allowlist. Other runtime
tools, plugins, and trusted hooks may have side effects. There is no OS sandbox.
Use a disposable repository and a dedicated environment for untrusted work.

The headless transport provides no ZC interactive permission response. ZC cannot
show an Allow dialog and does not simulate approval by changing modes or rerunning
a command. A request requiring an interactive answer must be handled in the
original client. Approval-enabled editing remains a release blocker for this path.

## Sessions, failure, and recovery

Within a successful conversation, a new user turn resumes the exact upstream ID
returned by the previous turn. `/sessions` lists frontend-created records for the
same real workspace, runtime configuration, and policy. `/resume <id>` takes a ZC
local session ID, not an arbitrary upstream ID. It restores the visible transcript
and uses the stored upstream ID for future prompts. The record is in:

```text
<ZC state directory>/stream-sessions/<workspace hash>/<local session UUID>.json
```

The record contains bounded display history and routing metadata, not credentials.
The upstream runtime still owns complete model context and its own history files.
ZC does not import unrelated upstream sessions or promise complete tool detail for
history beyond its display budget. `/export` saves what is visible. Manual `/compact`
is not integrated in this preview; automatic context handling is owned by ZCode.

A `.json.lock` file is held while a frontend owns a record. Concurrent frontend
resume is refused. A crash can leave a lock. Inspect its PID locally and confirm
that its owner has stopped before removing a stale lock. Do not open the same
upstream conversation concurrently through ZC and the original client.

Completion requires the main session/turn identity, a successful completed-turn
record, matching final response, idle projection, and process exit code zero.
Missing, malformed, mismatched, or truncated results are errors. A printed assistant
message before an error is not proof that the whole run succeeded.

Cancellation and timeouts request termination and then enforce bounded cleanup.
They do not roll back completed effects. No old prompt is automatically replayed.
If an interrupted run did not report an upstream session ID, ZC refuses to silently
replace that conversation. Inspect the original client and explicitly use `/new`.

For `project_token_login_failed`, leave ZC and authenticate through the installed
client's documented OAuth command. Do not upload credentials or raw provider logs.
The observed fresh-login recovery is not a guarantee against recurrence.

## Sources and verification boundary

- [Client per-prompt model argument, pinned to the observed release](https://github.com/kingsword09/zcode-cli/blob/v3.15.3-36/src/prompt-model.ts)
- [Client launcher and token ownership](https://github.com/kingsword09/zcode-cli/blob/v3.15.3-36/src/launcher.ts)
- [Inspected headless output contract](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/cli/src/prompt-command.ts)
- [Inspected headless permission behavior](https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/apps/zcode-cli/packages/cli/src/headless-workflow.ts)

Current test results are recorded in [VALIDATION.md](VALIDATION.md). Local tests use
synthetic subprocess fixtures, not this account or a live provider.
