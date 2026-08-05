#!/usr/bin/env bash
# Stable macOS entry point. Keep commands aligned with harness.ps1 while the
# implementation delegates into the portable application layer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/macos-harness.ts" "$@"
