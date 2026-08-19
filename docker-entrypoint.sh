#!/usr/bin/env bash
# Container entrypoint: the forwarding router (:3457) plus the lens traffic
# dashboard (:3458). Set LENS_ENABLED=false for a forwarding-only process tree.
#
# The two are not equals. Forwarding is the reason this container exists; the
# dashboard only reads a log it never writes to. So the router going down ends
# the container and lets the orchestrator restart it, while the dashboard going
# down costs you the dashboard and nothing else — it is restarted in place,
# with a backoff, and forwarding never notices.
set -euo pipefail

mkdir -p /app/logs /app/data

case "${LENS_ENABLED:-true}" in
  false|0|no|off)
    exec /usr/local/bin/open-claude-router
    ;;
esac

# Give up relaunching the dashboard after this many failures in a row; a crash
# loop should not spin forever, and losing observability must never escalate
# into losing the forwarder.
LENS_MAX_RESTARTS="${LENS_MAX_RESTARTS:-5}"
LENS_RESTART_DELAY="${LENS_RESTART_DELAY:-5}"

/usr/local/bin/open-claude-router &
ROUTER_PID=$!
/usr/local/bin/ocr-lens &
LENS_PID=$!

terminate() {
  kill -TERM "$ROUTER_PID" "$LENS_PID" 2>/dev/null || true
}
trap terminate TERM INT

lens_failures=0
while :; do
  # Wakes on whichever child exits first; the status must not abort the script
  # (set -e) before we work out which one it was.
  wait -n "$ROUTER_PID" "$LENS_PID" 2>/dev/null || true

  if ! kill -0 "$ROUTER_PID" 2>/dev/null; then
    echo "entrypoint: router exited, stopping container" >&2
    break
  fi

  if kill -0 "$LENS_PID" 2>/dev/null; then
    # Neither child is gone (a stray signal woke us); keep waiting.
    continue
  fi

  lens_failures=$((lens_failures + 1))
  if [ "$lens_failures" -gt "$LENS_MAX_RESTARTS" ]; then
    echo "entrypoint: dashboard failed ${lens_failures} times, leaving it down; forwarding continues" >&2
    wait "$ROUTER_PID" || true
    break
  fi

  echo "entrypoint: dashboard exited, restarting in ${LENS_RESTART_DELAY}s (attempt ${lens_failures}/${LENS_MAX_RESTARTS}); forwarding unaffected" >&2
  sleep "$LENS_RESTART_DELAY"
  /usr/local/bin/ocr-lens &
  LENS_PID=$!
done

terminate
wait || true
