#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

MODE="${RUN_MODE:-all}"

case "$MODE" in
  web)
    echo "Starting web control panel only."
    exec npm start
    ;;
  telegram)
    echo "Starting Telegram bot only."
    exec npm run telegram
    ;;
  all)
    echo "Starting web control panel and Telegram bot."
    exec npm run start:all
    ;;
  *)
    echo "Unknown RUN_MODE=$MODE. Use web, telegram, or all."
    exit 1
    ;;
esac
