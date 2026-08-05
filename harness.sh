#!/usr/bin/env bash
# Stable macOS entry point. Keep commands aligned with harness.ps1 while the
# implementation delegates into the portable application layer.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$ROOT/scripts/macos-harness.mjs" "$@"
