#!/usr/bin/env bash
# lmstudio-zh launcher (Linux/macOS). Node probe chain: system node -> LM Studio bundled node.
# ASCII-only on purpose: keep the launcher byte-for-byte portable across locales.
# All user-facing messages live in cli.mjs (UTF-8).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v node >/dev/null 2>&1; then
  exec node "$HERE/bin/lmstudio-zh.mjs" "$@"
fi

# Fall back to LM Studio's bundled Node (.deb install and AppImage-extracted dirs)
for candidate in \
  "$HOME/.lmstudio/.internal/utils/node" \
  "$HERE/lmstudio/resources/app/.webpack/bin/node" \
  "$HOME/.local/share/lm-studio/resources/app/.webpack/bin/node" \
  "/opt/LM Studio/resources/app/.webpack/bin/node"; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$HERE/bin/lmstudio-zh.mjs" "$@"
  fi
done

echo "[lmstudio-zh] Node.js not found. Install Node.js 18+ or make sure LM Studio is installed." >&2
exit 1
