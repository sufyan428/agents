# Agent 8 - AI Reporting Agent

Narrates agent5's structured compliance/audit/configuration/self-healing reports, plus the orchestrator's live health overview and agent7's incidents (if running), into a readable Markdown digest. Doesn't collect any data itself - it reads what agent5 already computed. BYOK - Claude or OpenRouter (free by default).

## Setup

No `.env` needed if you're running via `agent6` (the orchestrator) - paste your key once into `agent6/.env` and this agent inherits it. For standalone use, copy `.env.example` to `.env` here instead.

## Reports

Runs a scheduled digest daily (`schedule.digest_cron` in `config.yml`, default 06:00) and saves each report to `./reports/<id>.md` as well as in-memory history.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Process health |
| GET | `/api/reports` | History (metadata only, no markdown body) |
| GET | `/api/reports/latest` | Full latest report |
| GET | `/api/reports/:id` | Full report by id |
| POST | `/api/reports/generate` | Trigger an on-demand digest right now |

```sh
curl -X POST http://localhost:9097/api/reports/generate
```
