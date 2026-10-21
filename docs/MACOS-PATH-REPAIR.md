# ZC 0.2.0 macOS path repair

Date: 2026-10-20. This repairs the unpublished GitHub source handoff. It does not
change the runtime dependency, application version, authentication, publisher
permissions, or release-branch behavior.

## Failure and cause

The user's macOS publication check passed 227 of 229 tests. The path test expected
an unresolved `/var/folders/...` path while `safePath` correctly returned the
canonical `/private/var/folders/...` path. The Git listing test then lost the valid
`source.ts` entry.

`safePath` already canonicalizes the workspace root and rejects symbolic links
inside it. `projectFiles` mixed that canonical result with the original root when
computing relative prefixes. With an aliased root, the Git filter discarded valid
files. The fallback walker could also produce parent-prefixed display paths, and
search would not find the intended files.

## Change

- Resolve the listing root before validation, Git execution, and relative-path
  calculations, and use that same root in each operation.
- Compare the path test with the canonical fixture root, not its unresolved alias.
- Add six regression tests for aliased ancestors: canonical paths, Git listing,
  subdirectory filtering, fallback walking, source search, and retained rejection
  of traversal, private paths, interior links, and hard links.

The implementation of `safePath` is unchanged. Root aliases are not treated as
permission to follow links inside the workspace. No test was removed or disabled.
The fallback walker still does not interpret `.gitignore` when Git enumeration
fails; this repair does not change that existing behavior.

## Executed validation

Environment: Linux x64, Node.js 22.16.0, npm 10.9.2, Git 2.47.3.

1. Ran the original tools suite with TMPDIR pointing through a real directory
   symlink. It reproduced exactly the two reported failures: 13 passed, 2 failed.
2. Ran the added alias tests against the original implementation. Four new listing
   and search cases failed before the implementation change.
3. Ran the patched full build and test suite: 235 passed, 0 failed, 0 skipped.
4. Repeated the full suite with the aliased TMPDIR: 235 passed, 0 failed, 0 skipped.

This is a local reproduction of the filesystem condition, not native macOS or
Windows execution. Node 24 could not be downloaded because registry DNS was
unavailable in the build container. The existing publisher still requires Node
24.14+ and runs all checks again on the user's Mac before any Git operation.

No GitHub push, pull request, npm publication, user credential access, or live
provider request was performed during this repair. Earlier validation records
remain historical results for the earlier source.

## Apply to the existing handoff

Run the companion `zc-macos-path-repair.mjs` from the extracted handoff directory.
It accepts only the known original or repaired contents, saves original files to
a backup directory, and updates the source checksum manifest. It makes no network
requests or Git operations and does not run installation or authorization.

Then run the existing publisher with the supported Node engine:

```bash
npx --yes --package=node@24 -- node publish.mjs
```

The publisher remains unchanged. Tests are required; failed tests stop publication.
