# Compatibility

## Managed path

ZC 0.2.0 pins **zcode-app-cli 3.15.3-37**. The user's existing client at that version reported **zcode-runtime 0.16.9**. The managed resolver checks the npm package identity/version and uses only its public CLI bin. It does not infer an API from private `vendor` files.

The source frontend tests run on Node 22.16.0, while the managed production runtime requires Node 24.14 or newer. The supplied installers target Node 24.22.0. An incompatible engine or missing dependency is reported instead of silently substituting an external runtime or API backend.

Local runtime authentication, account entitlement, native Windows/macOS execution, and a full networked installer run were not available for this build. See [VALIDATION.md](VALIDATION.md).

## Mouse and terminal support

ZC enables SGR mouse reporting with button/drag events in the alternate screen. Click and drag editing need those reports to reach the application. A terminal or tmux layer can intercept gestures. Keyboard editing remains available: Ctrl+A, Shift+arrows, Backspace/Delete, Ctrl+Z, Ctrl+R, and Page Up/Page Down. Up/Down does not recall old prompts even when a terminal translates a wheel gesture into arrow keys.

`/mouse off` returns mouse gestures to the terminal, including its own selection behavior. This is not an editable prompt selection: terminal selection and ZC selection are separate. Clipboard requests use OSC 52 only after explicit selection-copy/cut; support varies. `/export` remains the portable full-transcript path.

Auto theme uses an OSC 11 background query. No response means inherited terminal foreground, not guessed pale text. Explicit themes paint their own background. Very small terminals show a resize hint. Unicode grapheme widths depend on terminal behavior.

## Advanced paths

External runtime overrides remain available for integration tests and advanced users. Their version/protocol compatibility is the caller's responsibility. Native read-only uses the inspected upstream allowlist and plan mode, not OS isolation. Some runtime distributions reject legacy plan options; normal guarded native operation is the main path.

The legacy `native-stream` backend is kept for earlier sessions. It is not the default, cannot show interactive permission dialogs, and retains its existing total/idle deadlines. Do not use it as a replacement for the new native long-turn monitoring.

The direct Z.ai API backend remains explicit and uses API-key billing. It is not an automatic fallback for failed account login.
