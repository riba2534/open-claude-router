#!/usr/bin/env bash
# Runs the router (model port) and the lens dashboard (web port) in one
# container for the observability test deployment. SIGTERM stops both.
set -euo pipefail

mkdir -p /app/logs /app/data

/usr/local/bin/open-claude-router &
ROUTER_PID=$!
/usr/local/bin/ocr-lens &
LENS_PID=$!

terminate() {
  kill -TERM "$ROUTER_PID" "$LENS_PID" 2>/dev/null || true
}
trap terminate TERM INT

# Exit as soon as either process dies so the container restarts cleanly.
wait -n "$ROUTER_PID" "$LENS_PID"
terminate
wait || true
