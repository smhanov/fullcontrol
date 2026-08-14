#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${FULLCONTROL_PROFILE:-$ROOT/chrome-profile}"
CHROME="${CHROME_PATH:-$ROOT/.tools/chrome-linux64/chrome}"
if [[ ! -x "$CHROME" ]]; then
  CHROME="$(command -v google-chrome || true)"
fi
mkdir -p "$PROFILE"
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --disable-extensions-except="$ROOT/extension" \
  --load-extension="$ROOT/extension" \
  --enable-unsafe-extension-debugging \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --window-size=1280,900 \
  "$@"
