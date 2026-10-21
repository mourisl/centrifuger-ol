#!/usr/bin/env bash
# Install a pinned Emscripten SDK into ./emsdk (then: source scripts/env.sh).
set -euo pipefail
EMSDK_VERSION=${EMSDK_VERSION:-6.0.13}
WA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WA_DIR"
[ -d emsdk ] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
source scripts/env.sh   # picks a Python >= 3.10 for EMSDK_PYTHON
cd emsdk
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
