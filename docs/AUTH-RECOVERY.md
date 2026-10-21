> Historical integration notes from the 0.1.x preview. Current setup and limitations are in [README](../README.md) and [COMPATIBILITY](COMPATIBILITY.md).

# Account authentication update

Date: 2026-10-19. Frontend: ZC 0.1.3 integration preview.

## What is established

The user supplied one successful account-backed headless run with client
3.15.3-36, followed about half an hour later by `project_token_login_failed`
inside ZC 0.1.2. These observations do not prove that a token expired or identify
whether the later failure was caused by token type, renewal, account state,
network conditions, or a process-environment difference.

Inspection of the delivered 0.1.2 source confirms that its stream backend passes
`process.env` to the client and uses the same explicit model, guarded mode, and
exclusion flags as the successful headless command. It does not read credential
files. This source inspection is not a comparison of the user's actual two
process environments. The frontend launches with ignored stdin, piped output,
and a separate process group on POSIX.

## Relevant upstream repair

The community client published release 3.15.3-37 on 2026-10-19. Its authentication
change addresses an incompatible token contract: Desktop and CLI wrote different
kinds of token into the same credential field. The patch publishes the business
token expected by the shared store, derives account identities from the active
shared profile, and migrates a legacy token only after a successful exchange.

Sources:

- [Release 3.15.3-37](https://github.com/kingsword09/zcode-cli/releases/tag/v3.15.3-37)
- [Merged authentication repair, PR 218](https://github.com/kingsword09/zcode-cli/pull/218)
- [Patch source at 3.15.3-37](https://github.com/kingsword09/zcode-cli/blob/v3.15.3-37/scripts/runtime-shared-oauth-patches.ts)

This is a relevant upstream correction, not proof of the cause of this user's
failure. A successful test after upgrading still would not prove long-lived
credential renewal.

## What changed in ZC

ZC 0.1.3 accepts the explicitly listed client versions 3.15.3-36 and 3.15.3-37
with runtime 0.16.9. It recommends 3.15.3-37, reports the actual detected version,
and rejects duplicate or conflicting identity lines. Other versions are rejected.
A version probe is not an authentication test or executable integrity check.

The token-exchange error no longer prescribes unconditional repeated login.
There are no changes to credential contents, permission mode, tool exclusions,
automatic retries, or process-environment handling in this frontend patch.

## Targeted installation on the user's Linux server

Exit running ZC and community-client sessions first. Do not run the older client
concurrently while testing updated account handling. Keep existing configuration;
do not delete `~/.zcode` or print its credential files.

After uploading the 0.1.3 tarball into your home directory, install both packages
into your user-owned prefix, without replacing the older system installation:

```bash
npx --yes --package=node@24 -- npm install --global \
  --prefix "$HOME/.local" \
  "$HOME/striking-lions-zc-0.1.3.tgz" \
  zcode-app-cli@3.15.3-37
```

Check the new executable explicitly, then point ZC at it:

```bash
npx --yes --package=node@24 -- "$HOME/.local/bin/zcode" --version
npx --yes --package=node@24 -- "$HOME/.local/bin/zc" config runtime "$HOME/.local/bin/zcode"
```

Expected client/runtime pair: 3.15.3-37 / 0.16.9. Stop on a different pair. The
new binary uses the existing upstream account store; a separate installation
prefix does not isolate account credentials or sessions.

For this recovery test, authorize once using the updated client so the new
credential-publication path is used:

```bash
npx --yes --package=node@24 -- "$HOME/.local/bin/zcode" login --oauth --no-browser
```

Open the newly printed authorization URL privately and wait for success in the
terminal. Do not paste the URL, callback code, or tokens into a bug report.
Then launch in the existing disposable smoke workspace:

```bash
npx --yes --package=node@24 -- "$HOME/.local/bin/zc" stream \
  --model 'account:zai-individual-coding-plan/GLM-5.3' \
  --cwd "$HOME/zc-stream-check.IWa6FG"
```

Submit the same smoke-file prompt manually. An error must not silently replay
it. If token exchange fails immediately after authorization with the new client,
stop repeating login. Compare the direct headless invocation and the frontend
in the same shell, using the same absolute executable and existing credentials,
before changing another variable.

The package update itself, live login, actual 3.15.3-37 runtime execution, and
live frontend recovery have not been executed in the build container. GitHub's
release and source were inspected; npm registry access from the build container
failed with a DNS error. No claim that the upstream package installed locally is
made. The user's installation command should stop if fetching the pinned release
fails. Do not substitute an arbitrary package or unverified mirror.

The guarded headless policy is unchanged: no ZC approval-enabled editing and no
OS sandbox. Other upstream tools or plugins can still have side effects.
