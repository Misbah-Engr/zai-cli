#!/usr/bin/env bash
# User-owned, versioned installation. No sudo and no credential-file access.
set -Eeuo pipefail
umask 077
VERSION=0.2.0
NODE_VERSION=24.22.0
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE="$SCRIPT_DIR/striking-lions-zc-$VERSION.tgz"
ADD_PATH=0
CONFIG_CHANGED=0
COMMITTED=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package) [ "$#" -ge 2 ] || { echo 'Missing --package path.' >&2; exit 1; }; PACKAGE="$2"; shift 2 ;;
    --add-path) ADD_PATH=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" -ne 0 ] || { echo 'Run this as your normal user, not root.' >&2; exit 1; }
[ -f "$PACKAGE" ] || { echo "Package is missing: $PACKAGE" >&2; exit 1; }
PACKAGE="$(cd -- "$(dirname -- "$PACKAGE")" && pwd)/$(basename -- "$PACKAGE")"
case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) echo 'Use install.ps1 on Windows. This installer supports macOS and glibc Linux.' >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) echo 'Supported architectures: x64 and arm64.' >&2; exit 1 ;; esac
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
command -v tar >/dev/null || { echo 'tar is required.' >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
BASE="${XDG_DATA_HOME:-$HOME/.local/share}/zc"
BIN="$HOME/.local/bin"
mkdir -p "$BASE/releases" "$BASE/engines" "$BIN"
STAGE="$(mktemp -d "$BASE/releases/.install.XXXXXX")"
cleanup() { if [ -n "${STAGE:-}" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi; }
trap cleanup EXIT
on_error() {
  local code=$?
  trap - ERR
  if [ "$CONFIG_CHANGED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
    if ! "$NODE" "$RELEASE/app/node_modules/@striking-lions/zc/scripts/restore-config.mjs" "$RELEASE/previous-zc-config.json"; then
      echo "Could not restore ZC preferences. The backup is at $RELEASE/previous-zc-config.json" >&2
    fi
  fi
  echo 'Installation stopped. Retained releases and account credentials were not deleted.' >&2
  exit "$code"
}
trap on_error ERR
SUMS="$SCRIPT_DIR/SHA256SUMS.txt"
if [ -f "$SUMS" ]; then
  EXPECTED="$(awk -v f="$(basename -- "$PACKAGE")" '$2==f {print $1}' "$SUMS")"
  [[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Package checksum is missing or ambiguous.' >&2; exit 1; }
  [ "$(sha256 "$PACKAGE")" = "$EXPECTED" ] || { echo 'Package checksum mismatch.' >&2; exit 1; }
else
  echo 'No local checksum manifest. Inspect the source of this package before installing.' >&2
fi
NAME="node-v$NODE_VERSION-$OS-$ARCH"
ENGINE="$BASE/engines/$NAME"
NODE="$ENGINE/bin/node"
NPM="$ENGINE/lib/node_modules/npm/bin/npm-cli.js"
if [ ! -x "$NODE" ] || [ ! -f "$NPM" ]; then
  echo "Installing an isolated Node $NODE_VERSION engine for ZC. System Node is unchanged."
  URL="https://nodejs.org/dist/v$NODE_VERSION"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --retry 3 --connect-timeout 15 --max-time 600 "$URL/$NAME.tar.gz" -o "$STAGE/node.tar.gz"
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --retry 3 --connect-timeout 15 --max-time 60 "$URL/SHASUMS256.txt" -o "$STAGE/node-checksums.txt"
  EXPECTED="$(awk -v f="$NAME.tar.gz" '$2==f {print $1}' "$STAGE/node-checksums.txt")"
  [[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Node checksum entry is missing.' >&2; exit 1; }
  [ "$(sha256 "$STAGE/node.tar.gz")" = "$EXPECTED" ] || { echo 'Node archive checksum mismatch.' >&2; exit 1; }
  tar -xzf "$STAGE/node.tar.gz" -C "$STAGE"
  "$STAGE/$NAME/bin/node" --version
  if [ -e "$ENGINE" ]; then echo 'An incomplete engine directory exists. No existing engine was overwritten.' >&2; exit 1; fi
  mv -- "$STAGE/$NAME" "$ENGINE"
fi
[ "$("$NODE" --version)" = "v$NODE_VERSION" ] || { echo 'Managed Node version mismatch.' >&2; exit 1; }
export PATH="$ENGINE/bin:$PATH"
echo 'Installing ZC and its pinned coding runtime together...'
"$NODE" "$NPM" install --prefix "$STAGE/app" --ignore-scripts --no-audit --no-fund --save-exact \
  --registry=https://registry.npmjs.org/ --fetch-retries=3 --fetch-retry-mintimeout=5000 \
  --fetch-retry-maxtimeout=20000 --fetch-timeout=120000 --maxsockets=2 "$PACKAGE"
ENTRY="$STAGE/app/node_modules/@striking-lions/zc/bin/zc.mjs"
[ "$("$NODE" "$ENTRY" --version)" = "$VERSION" ] || { echo 'Installed ZC version mismatch.' >&2; exit 1; }
"$NODE" "$STAGE/app/node_modules/@striking-lions/zc/scripts/verify-runtime.mjs"
"$NODE" "$ENTRY" config > "$STAGE/previous-zc-config.json"
RELEASE="$BASE/releases/$VERSION-$(date +%Y%m%d%H%M%S)-$$"
mv -- "$STAGE" "$RELEASE"; STAGE=''
ENTRY="$RELEASE/app/node_modules/@striking-lions/zc/bin/zc.mjs"
WRAPPER="$(mktemp "$BIN/.zc-launcher.XXXXXX")"
# Bash %q safely quotes paths including spaces and apostrophes.
{ printf '#!/usr/bin/env bash\nexec '; printf '%q ' "$NODE" "$ENTRY"; printf '"$@"\n'; } > "$WRAPPER"
chmod 755 "$WRAPPER"
if [ -e "$BIN/zc" ] || [ -L "$BIN/zc" ]; then cp -P -- "$BIN/zc" "$RELEASE/previous-launcher"; fi
[ ! -d "$BIN/zc" ] || { echo 'The zc launcher path is a directory. It was not replaced.' >&2; exit 1; }
# Change preferences only once the new executable and backup are prepared.
"$NODE" "$ENTRY" config managed
CONFIG_CHANGED=1
mv -f -- "$WRAPPER" "$BIN/zc"
COMMITTED=1
if [ "$ADD_PATH" -eq 1 ]; then
  PROFILES=("$HOME/.profile")
  case "${SHELL:-}" in */zsh) PROFILES+=("$HOME/.zshrc") ;; *) PROFILES+=("$HOME/.bashrc") ;; esac
  for PROFILE in "${PROFILES[@]}"; do
    if [ -L "$PROFILE" ]; then echo "Skipped symlinked shell profile: $PROFILE"; continue; fi
    if ! grep -Fq '# ZC launcher PATH' "$PROFILE" 2>/dev/null; then
      if ! printf '\n# ZC launcher PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$PROFILE"; then
        echo "Could not update $PROFILE. Add $BIN to PATH manually." >&2
      fi
    fi
  done
fi
printf '\nInstalled ZC %s. Runtime and engine are managed inside %s\n' "$VERSION" "$BASE"
echo 'Open a new terminal, change into your project, and run: zc'
echo 'First account connection: zc login. Existing account credentials were not deleted.'
printf 'Use immediately in this terminal: %s\n' "$BIN/zc"
printf 'Retained installation: %s\n' "$RELEASE"
