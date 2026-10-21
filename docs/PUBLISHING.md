# Publishing ZC

This delivery provides a source archive, an npm package, and an installation ZIP. It does not claim an npm registry publication or a successful GitHub push.

## Validate before sharing

```bash
npm run check
python3 scripts/terminal-smoke.py
npm pack
```

On a networked release machine with Node 24.14 or newer, perform a clean npm install so the pinned runtime and its transitive dependencies are installed. The package has no postinstall script. Check login, actual model/tool activity, cancellation, permission denial, a reviewed edit, and session resume on the target platforms before calling it stable.

The included GitHub Actions matrix targets Windows, Linux, and macOS. A configuration file is not proof those jobs passed. Run it after publishing the source and retain its actual results.

## Repository

The optional publisher uses an authenticated GitHub CLI, defaults to a new private repository, and refuses an existing origin/target instead of force-pushing:

```bash
gh auth login
node scripts/publish.mjs --dry-run
node scripts/publish.mjs
```

For an existing repository, use a reviewed branch and pull request. Do not replace history. Keep the runtime as a pinned dependency rather than checking in user credentials, session databases, or copied vendor bundles. The publisher does not publish to npm.

## Install ZIP

The ZIP contains `install.sh`, `install.ps1`, `striking-lions-zc-0.2.0.tgz`, `SHA256SUMS.txt`, and `QUICKSTART.md` at the same level. The installer downloads its isolated Node engine and runtime dependencies. It is not an offline distribution.

A registry or signed binary release needs its own authorized publishing account, signing/provenance process, complete dependency lock, and target-platform release validation. These are not simulated by a local tarball.
