#!/usr/bin/env bash
#
# Boots the orchestrator, waits for it to bring the core agents up, and asserts
# that every one of them is running AND answering its health endpoint.
#
# Deliberately checks health rather than just process state: an agent that
# spawned and then failed to bind its port is not working, and "the process
# exists" is exactly the kind of assertion that lets a broken build through.
#
# Expects the router simulator to already be running (see the CI workflow, or
# `npm run sim` in another terminal).
#
# Usage: bash scripts/smoke-test.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT_SECONDS=120
READY_TIMEOUT=90
API="http://127.0.0.1:8080"
LOG_FILE="${TMPDIR:-/tmp}/orchestrator.log"

CORE_AGENTS=(
  agent1-monitoring
  agent2-resilience
  agent3-security
  agent4-performance
  agent5-automation
)

cleanup() {
  if [ -n "${ORCH_PID:-}" ] && kill -0 "$ORCH_PID" 2>/dev/null; then
    kill "$ORCH_PID" 2>/dev/null || true
    # The orchestrator stops its own children on SIGTERM; give it a moment.
    sleep 3
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1"
  echo "--- orchestrator log (last 60 lines) ---"
  tail -60 "$LOG_FILE" 2>/dev/null || echo "(no log)"
  exit 1
}

echo "Starting the orchestrator..."
(
  cd "$ROOT_DIR/agent6"
  AGENT_API_TOKEN="${AGENT_API_TOKEN:-smoke-test-token}" \
    timeout "$BOOT_SECONDS" node src/index.js > "$LOG_FILE" 2>&1
) &
ORCH_PID=$!

echo "Waiting for the API gateway..."
for _ in $(seq 1 30); do
  curl -sf -m 2 "$API/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 2 "$API/health" >/dev/null 2>&1 || fail "the gateway never answered on $API"

echo "Waiting up to ${READY_TIMEOUT}s for the core agents to become healthy..."
DEADLINE=$((SECONDS + READY_TIMEOUT))
while [ $SECONDS -lt $DEADLINE ]; do
  OVERVIEW=$(curl -sf -m 5 "$API/api/overview" 2>/dev/null || echo '')
  [ -z "$OVERVIEW" ] && { sleep 3; continue; }

  READY=$(printf '%s' "$OVERVIEW" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const core = process.argv.slice(1);
      try {
        const agents = JSON.parse(s).overview.agents;
        // Both conditions matter: running means the process is up, healthy
        // means it is actually serving. An agent can be one without the other.
        const ok = core.filter((n) => agents[n] && agents[n].status === "running" && agents[n].healthy);
        console.log(ok.length);
      } catch { console.log(0); }
    });
  ' "${CORE_AGENTS[@]}")

  echo "  ${READY}/${#CORE_AGENTS[@]} core agents running and healthy"
  [ "$READY" -eq "${#CORE_AGENTS[@]}" ] && { echo "PASS: every core agent is up and healthy"; exit 0; }
  sleep 5
done

echo "--- final overview ---"
curl -sf -m 5 "$API/api/overview" || true
echo
fail "the core agents did not all become healthy within ${READY_TIMEOUT}s"
