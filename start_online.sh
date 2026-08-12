#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export ZARNEGAR_ALLOW_NO_TOKEN="${ZARNEGAR_ALLOW_NO_TOKEN:-1}"
export ZARNEGAR_PORT="${ZARNEGAR_PORT:-8080}"
export ZARNEGAR_HOST="${ZARNEGAR_HOST:-0.0.0.0}"
exec python3 zarnegar_online.py
