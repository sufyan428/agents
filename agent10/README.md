# Agent 10 - AI ChatOps Agent

Natural-language interface over the orchestrator's API - ask about framework status, or tell it to restart/stop/start an agent. BYOK - Claude or OpenRouter (free by default).

## Confirmation gate on destructive actions

The LLM never executes anything directly - it only classifies your message into a fixed action registry. Read-only actions (status/health/incidents/reports/suggestions) run immediately. `restart_agent`/`stop_agent`/`start_agent` instead return a `pendingAction` that you must round-trip to `/api/chat/confirm` before anything actually happens - a natural-language request alone is never enough.

## Setup

No `.env` needed if you're running via `agent6` (the orchestrator) - paste your key once into `agent6/.env` and this agent inherits it. For standalone use, copy `.env.example` to `.env` here instead.

Optional: set `SLACK_WEBHOOK_URL` or `DISCORD_WEBHOOK_URL` to push agent7's incidents and agent8's digests to a real channel automatically. Without either, this agent still works fully via its own endpoints - proactive findings just get recorded locally instead (`GET /api/notifications`).

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Process health |
| POST | `/api/chat` | `{"message": "..."}` - main entry point |
| POST | `/api/chat/confirm` | `{"pendingAction": {...}}` - confirms and executes a destructive action returned by `/api/chat` |
| GET | `/api/notifications` | History of proactively pushed findings |

```sh
# Read-only - executes immediately
curl -X POST http://localhost:9099/api/chat -H "Content-Type: application/json" \
  -d '{"message": "what is the overall status of the framework?"}'

# Destructive - returns a pendingAction, does NOT execute yet
curl -X POST http://localhost:9099/api/chat -H "Content-Type: application/json" \
  -d '{"message": "restart agent2-resilience"}'

# Confirm the exact pendingAction from the previous response to actually run it
curl -X POST http://localhost:9099/api/chat/confirm -H "Content-Type: application/json" \
  -d '{"pendingAction": {"action": "restart_agent", "agentName": "agent2-resilience"}}'
```
