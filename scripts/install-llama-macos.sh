#!/usr/bin/env bash
# macOS infrastructure adapter.  It deliberately installs the native Metal
# build; model/routing policy stays in the shared Node domain/application code.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only." >&2
  exit 2
fi
if ! command -v brew >/dev/null; then
  echo "Homebrew is required to install the supported native Metal llama.cpp build: https://brew.sh" >&2
  exit 1
fi
brew install llama.cpp
command -v llama-server >/dev/null || { echo "Homebrew did not provide llama-server." >&2; exit 1; }
llama-server --version
llama-server --list-devices || true
