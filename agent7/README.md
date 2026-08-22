# Agent 7 - AI Correlation & Reasoning Agent

Correlates signals across agents 1-5 (and the orchestrator) to spot cross-agent incidents that no single agent would catch alone, and answers ad-hoc natural-language questions about framework state. BYOK - Claude or OpenRouter (free by default).

## How it decides when to call the LLM

Polls the orchestrator + each agent's `/health` every `correlation.poll_interval_seconds` (default 60s). Only spends an LLM call when something looks anomalous (an agent unreachable/unhealthy, or a status flip since the last poll) - plus one guaranteed baseline check every `baseline_every_n_polls` cycles regardless, so slow-building issues aren't missed just because no single poll looked wrong.

## Setup

No `.env` needed if you're running via `agent6` (the orchestrator) - paste your key once into `agent6/.env` and this agent inherits it. For standalone use, copy `.env.example` to `.env` here instead.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Process health |
| GET | `/api/snapshot` | Latest raw collected data (all agents' health) |
| GET | `/api/incidents` | Latest correlation result + running metrics |
| POST | `/api/ask` | `{"question": "..."}` - ad-hoc natural-language Q&A over current + recent history |

```sh
curl -X POST http://localhost:9096/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "why is agent2 unhealthy?"}'
```
