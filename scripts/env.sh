# Source this file to put the local emsdk toolchain on PATH.
# Usage: source scripts/env.sh   (from claude/webassembly/)
_WA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export EMSDK="$_WA_DIR/emsdk"
# emsdk/emcc need Python >= 3.10; override with EMSDK_PYTHON if needed.
if [ -z "$EMSDK_PYTHON" ]; then
  for p in python3.13 python3.12 python3.11 python3.10 /dartfs/rc/lab/S/SongL/lsong/miniconda3/bin/python3; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys; sys.exit(sys.version_info < (3,10))' 2>/dev/null; then
      export EMSDK_PYTHON="$(command -v "$p")"; break
    fi
  done
fi
_WA_NODE_BIN="$(ls -d "$EMSDK"/node/*/bin 2>/dev/null | head -1)"
export EMSDK_NODE="$_WA_NODE_BIN/node"
export PATH="$EMSDK/upstream/emscripten:$_WA_NODE_BIN:$EMSDK:$PATH"
unset _WA_DIR _WA_NODE_BIN
