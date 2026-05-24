#!/bin/zsh

cd "$(dirname "$0")" || exit 1

PORT=4173
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

python3 -m http.server "$PORT" >/tmp/minimal-pomodoro.log 2>&1 &
sleep 0.6
open "http://localhost:$PORT/index.html"
