# ZC 0.2.0 architecture

```text
User command: zc
  -> user-owned launcher
  -> isolated Node engine
  -> ZC editor, transcript, connection state, approvals
  -> published zcode-app-cli public bin (pinned npm dependency)
  -> app-server stdio protocol
  -> official agent runtime, account auth, sessions, tools
```

One install manages the components. They remain separate modules/processes internally so the frontend does not need to own OAuth credentials or patch runtime internals. This is integrated packaging, not a single native executable or an offline monolithic binary.

## Native lifecycle

`src/backends/native.mjs` creates/resumes a session, subscribes, projects visible events, and handles reverse permission requests. `native-turn.mjs` correlates a root prompt through inputId, queryId, or a verified legacy turn-start fallback. Silent periods trigger read-only health and paginated event queries. A confirmed terminal event finishes the turn. Ambiguous state is shown explicitly and does not send the original prompt again.

The native app-server/standalone distinction is documented by the installed client:
https://github.com/kingsword09/zcode-cli/blob/v3.15.3-37/docs/CONFIGURATION.md

The inspected legacy protocol source is pinned at:
https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/shared/src/zcode-protocol/index.ts

The protocol is not OpenAI Responses API or JSON-RPC 2.0. No model gateway/proxy is introduced by this change.

## Presentation

The input decoder handles bracketed paste, standard key sequences, terminal-background replies, and SGR mouse events. The editor stores graphemes, a caret, a selection anchor, and bounded undo history. Input editing, transcript scrolling, and explicit prompt recall are separate actions.

The renderer uses semantic palettes, cached message layout, a clipped transcript viewport, a visual scroll indicator, and a separate composer. It generates terminal cells, not a web UI or ANSI scrape of another TUI. No mouse click implicitly approves a permission dialog.

## Persistence

The upstream runtime owns agent conversation/context. ZC stores a visible transcript journal, unsent draft, trust records, and per-project last-session/model preferences. Opening a blank session does not replace the last used conversation. Search and export read the journal. History windows have both entry and byte budgets.

The journal retains visible entries beyond the 400-entry live working set. It cannot recover data that the older frontend discarded and that the runtime no longer exposes. It is not a raw forensic protocol capture.

## Distribution

`package.json` pins the public runtime dependency. `install/install.sh` and `install/install.ps1` stage isolated engines and versioned npm trees, then create a plain `zc` launcher. They retain the actual install lockfile and prior frontend preferences. Lifecycle scripts are disabled during installer dependency installation. Windows, macOS, and WSL are intended targets, not all locally verified platforms.
