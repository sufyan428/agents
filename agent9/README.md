# Agent 9 - AI Remediation Advisor

Suggests fixes for compliance violations (from agent5) and performance anomalies (from agent4), generates incident runbooks, and reviews proposed router config changes for risk - before anyone applies them. BYOK - Claude or OpenRouter (free by default).

## This agent never executes anything

Every response carries `requiresHumanApproval: true, autoApply: false`. There is no code path in this agent that applies a config change, restarts anything, or otherwise acts on its own suggestions - it only produces text for a human to read and act on. This is deliberate, not a missing feature.

## Setup

No `.env` needed if you're running via `agent6` (the orchestrator) - paste your key once into `agent6/.env` and this agent inherits it. For standalone use, copy `.env.example` to `.env` here instead.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Process health |
| GET | `/api/suggestions` | History of suggestions/runbooks/reviews |
| GET | `/api/suggestions/latest` | Most recent one |
| POST | `/api/suggestions/generate` | Check agent5/agent4 now and suggest fixes if anything's wrong |
| POST | `/api/runbook` | `{"incidentDescription": "..."}` (optional - falls back to agent7's latest incident if omitted) |
| POST | `/api/review` | `{"proposedChange": "..."}` - risk-review a proposed config change |

```sh
curl -X POST http://localhost:9098/api/review \
  -H "Content-Type: application/json" \
  -d '{"proposedChange": "Disable SNMP v1/v2c, enforce SNMPv3 only"}'
```

Also runs a periodic background check (`polling.interval_seconds`, default 120s) that generates a suggestion automatically when it finds a real issue - silent when everything's clean, so history isn't diluted with repeated "all clear" entries.
