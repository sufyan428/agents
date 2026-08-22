# Router Agent Framework

A 10-agent system for monitoring, securing, and optimizing router infrastructure, with an optional AI layer for cross-agent reasoning, reporting, remediation advice, and a natural-language operator interface.

## Architecture

```
agent1  monitoring            SNMP/syslog metrics (CPU, memory, bandwidth, uptime)
agent2  resilience/failover   primary/backup router failover via SNMP + ICMP heartbeat
agent3  security/IDS          intrusion detection - auth failures, traffic anomalies, config validation
agent4  performance           QoS/traffic optimization, latency/jitter/packet-loss tracking
agent5  automation/governance policy compliance, config backups, self-healing
agent6  orchestrator          starts/stops/health-checks agents 1-9, unified API gateway (port 8080)

--- optional AI layer (BYOK, free by default, disabled with no key configured) ---
agent7  correlation           cross-agent incident correlation + natural-language Q&A
agent8  reporting             narrates agent5's compliance/audit data into readable digests
agent9  remediation advisor   suggests fixes, generates runbooks, reviews config changes - NEVER auto-applies
agent10 chatops               natural-language interface over the framework, with a confirmation gate on anything destructive
```

Agents 1-6 have zero AI dependency and always run. Agents 7-10 are optional and only start if an API key is configured - the orchestrator detects this automatically and logs clearly when one is skipped.

## Quick start

Each agent is an independent Node project (own `package.json`, own dependencies - no shared/monorepo tooling).

```sh
# Install everything
for d in agent1 agent2 agent3 agent4 agent5 agent6 agent7 agent8 agent9 agent10; do (cd $d && npm install); done

# Start the framework - the orchestrator spawns and manages agents 1-5, plus 7-10 if a key is configured
cd agent6 && npm start
```

The orchestrator's API gateway comes up on **http://localhost:8080** — see `/api/overview` for live status of every agent.

### Enabling the AI layer (agents 7-10)

One file, one key, applies to all four agents:

```sh
cp agent6/.env.example agent6/.env
# edit agent6/.env, paste ONE key:
#   OPENROUTER_API_KEY=...   (free by default - nvidia/nemotron-3-nano-30b-a3b:free)
#   or ANTHROPIC_API_KEY=... (claude-opus-4-8)
```

Change the model anytime by editing `OPENROUTER_MODEL` / `ANTHROPIC_MODEL` in that same file - no code changes, no restarts of anything but the AI agents themselves. Each of agents 7-10 also accepts its own standalone `.env` (see each agent's `.env.example`) if you want to run one without the orchestrator - but the shared `agent6/.env` is the intended path for normal use.

### Docker

Each agent 1-5 also ships a `Dockerfile`, and `agent6/docker-compose.yml` brings up agents 1-5 plus Prometheus and Grafana as containers (isolated networking avoids the port conflicts that the bare-Node path has to work around - see below). This is a separate deployment path from `agent6 npm start`; agents 7-10 aren't in the compose file yet.

## Safety design

- **Agent9 never executes anything.** Every suggestion/runbook/review it produces carries `requiresHumanApproval: true, autoApply: false` - there is no code path that applies a change automatically.
- **Agent10 gates destructive actions.** Restarting/stopping/starting an agent via chat returns a `pendingAction` requiring an explicit round-trip to `/api/chat/confirm` before anything happens - a natural-language request alone never executes it.
- **Everything degrades gracefully with no real router hardware.** This framework was built and tested without a real router present - SNMP/ICMP timeouts against placeholder IPs are expected and handled (logged, not crashed) throughout. Point `router.yml`'s `primary`/`backup` host and `snmp_community` at real hardware for actual deployment.
- **Change the defaults before real production use:** `router.yml`'s `snmp_community: "public"` and `grafana.admin_password: "admin"` are placeholders, already marked `# CHANGE THIS` in the config.

## Configuration

`agent6/router.yml` is the master config - it sets router IPs/SNMP credentials, per-agent ports, and which agents are enabled, then distributes the relevant slice to each agent's own config on startup. Editing it and restarting the orchestrator is the normal way to reconfigure the framework; you shouldn't need to hand-edit individual agents' configs directly (`agent6` overwrites most of them on every start).

## Known environment quirks (by design, not bugs)

- Agent2's `/health` reflects whether the *monitored router* is reachable, not whether the process is healthy - expect `healthy: false` with no real hardware present.
- Free-tier LLM models vary in reliability. The shipped default (`nvidia/nemotron-3-nano-30b-a3b:free`) was picked by measurement, not preference: it returned valid structured output on every attempt at ~1.2s, while larger free models are more oversubscribed and return empty completions under load. Point the framework at any model you like via `OPENROUTER_MODEL` / `AI_MODEL` — agents 7-10 scale with whatever is behind them.

## License

MIT - see `LICENSE`.
