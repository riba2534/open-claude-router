#!/usr/bin/env bash
# Container entrypoint: the forwarding router (:3457) plus the lens traffic
# dashboard (:3458) in one container. Set LENS_ENABLED=false for a
# forwarding-only process tree. When both run, either process exiting stops
# the container so a supervisor can restart the pair together.
set -euo pipefail

mkdir -p /app/logs /app/data

case "${LENS_ENABLED:-true}" in
  false|0|no|off)
    exec /usr/local/bin/open-claude-router
    ;;
esac

/usr/local/bin/open-claude-router &
ROUTER_PID=$!
/usr/local/bin/ocr-lens &
LENS_PID=$!

terminate() {
  kill -TERM "$ROUTER_PID" "$LENS_PID" 2>/dev/null || true
}
trap terminate TERM INT

# Exit as soon as either process dies so the container restarts cleanly; the
# status must not abort the script (set -e) before cleanup runs.
wait -n "$ROUTER_PID" "$LENS_PID" || true
terminate
wait || true
