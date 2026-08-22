#!/usr/bin/env bash
# Boots the orchestrator (which spawns agents 1-5), waits for warmup, then
# asserts the orchestrator's own /api/overview reports all 5 core agents
# running. Agents 7-10 are intentionally left out of this check - they're
# BYOK and won't start without a key configured (expected, not a failure).
#
# Usage: bash scripts/smoke-test.sh   (run from the project root)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT_SECONDS=90
WARMUP_SECONDS=25
LOG_FILE="$(mktemp)"

cleanup() {
  if [ -n "${ORCH_PID:-}" ] && kill -0 "$ORCH_PID" 2>/dev/null; then
    kill "$ORCH_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_FILE"
}
trap cleanup EXIT

echo "Starting orchestrator for up to ${BOOT_SECONDS}s..."
(cd "$ROOT_DIR/agent6" && timeout "$BOOT_SECONDS" node src/index.js > "$LOG_FILE" 2>&1) &
ORCH_PID=$!

echo "Waiting ${WARMUP_SECONDS}s for all agents to come up..."
sleep "$WARMUP_SECONDS"

OVERVIEW=$(curl -s -m 5 http://localhost:8080/api/overview || echo '')

if [ -z "$OVERVIEW" ]; then
  echo "FAIL: orchestrator did not respond on http://localhost:8080/api/overview"
  echo "--- orchestrator log ---"
  cat "$LOG_FILE"
  exit 1
fi

RUNNING_COUNT=$(node -e "
const data = JSON.parse(process.argv[1]);
const agents = data.overview.agents;
const coreAgents = ['agent1-monitoring','agent2-resilience','agent3-security','agent4-performance','agent5-automation'];
const running = coreAgents.filter(name => agents[name] && agents[name].status === 'running');
console.log(running.length);
" "$OVERVIEW")

if [ "$RUNNING_COUNT" -eq 5 ]; then
  echo "PASS: all 5 core agents running"
  exit 0
else
  echo "FAIL: only $RUNNING_COUNT/5 core agents running"
  echo "--- overview ---"
  echo "$OVERVIEW"
  echo "--- orchestrator log ---"
  cat "$LOG_FILE"
  exit 1
fi
