#!/usr/bin/env bash
# Starts the bot and restarts it if it crashes. Arguments are passed on, e.g.:
#   scripts/start-bot.sh --server friend1
cd "$(dirname "$0")/.." || exit 1
while true; do
  node index.js "$@"
  code=$?
  [ "$code" -eq 0 ] && break
  echo "Bot stopped unexpectedly (exit code $code). Restarting in 15 seconds... (Ctrl+C to stop)"
  sleep 15
done
