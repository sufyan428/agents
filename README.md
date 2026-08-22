# Router Agent Framework

[![CI](https://github.com/sufiyansrepos/router-agent-framework/actions/workflows/ci.yml/badge.svg)](https://github.com/sufiyansrepos/router-agent-framework/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

A 10-agent system for monitoring, securing and optimizing router infrastructure.
Six agents form a deterministic core that never makes an AI call; four optional
agents add narration, reporting, advice and chat on top of it.

**It runs with no hardware and no API key.** A bundled router simulator gives it
a real SNMP responder and real syslog to work against, and incident correlation
is deterministic — `GET /api/incidents` works on a fresh clone.

```sh
npm ci && npm run build
npm run sim                    # terminal 1: a simulated router
cd agent6 && npm start         # terminal 2: the framework
```

Then break something and watch it react:

```sh
curl -X POST localhost:8090/fault/interface_flap
curl localhost:8080/api/incidents
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full walkthrough.

## The ten agents

| | Agent | Does | AI |
|---|---|---|---|
| 1 | monitoring | SNMP metrics, syslog, baselining, alerting | no |
| 2 | resilience | failover, heartbeat | no |
| 3 | security | intrusion detection | no |
| 4 | performance | latency, jitter, loss, QoS | no |
| 5 | governance | compliance, backups, self-healing | no |
| 6 | orchestrator | supervision, config, **incident correlation** | no |
| 7 | correlation | narrates agent6's incidents | optional |
| 8 | reporting | audit digests | optional |
| 9 | remediation | advice and runbooks; never executes | optional |
| 10 | chatops | natural language; confirms before acting | optional |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the diagram and the reasoning.

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

Agents 1-6 never make an AI call. The AI layer is optional, and the framework
detects, correlates and ranks incidents without it — `GET /api/incidents` on the
orchestrator works with no key configured at all. Agents 7-10 add narration,
digests, remediation advice and a chat interface on top of that.

Three values, in `agent6/.env`:

```sh
AI_API_KEY=...                                    # your key
AI_MODEL=nvidia/nemotron-3-nano-30b-a3b:free      # any model the endpoint accepts
AI_BASE_URL=https://openrouter.ai/api/v1          # any OpenAI-compatible endpoint
```

**The framework holds no opinion about which model you use** and maintains no
allowlist — one would be wrong within a month. The shipped default is free.

| Where | `AI_BASE_URL` | Notes |
|---|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` | Default. Free models available |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI-compatible endpoint |
| Together / Groq / Fireworks | their `/v1` | Any OpenAI-compatible host |
| Ollama (local) | `http://localhost:11434/v1` | No key needed; pass any string |
| vLLM / LM Studio | your `/v1` | Self-hosted |
| Anthropic | *(omit)* | Set `AI_PROVIDER=anthropic` instead |

Agents 7-10 scale with whatever is behind them. A free model works; a frontier
model works better. That is your call and your bill.

#### Spend control

Every AI agent enforces a local budget over a rolling 24 hours, before any
request leaves the process:

```sh
AI_DAILY_CALL_BUDGET=500     # 0 disables this agent's model use entirely
AI_DAILY_TOKEN_BUDGET=0      # 0 means no token limit
```

A circuit breaker opens after repeated failures, and an authentication failure
stops the layer outright rather than retrying a key that will not start working.
Unchanged incidents are not re-narrated — the same prose about the same ongoing
problem is not worth a model call.

#### Built for unreliable models

Free endpoints return empty completions under load, lack JSON mode, and often
have no tool calling. Rather than requiring features they may not have, the
client asks for JSON in the prompt and parses defensively: fence stripping,
balanced-brace extraction, trailing-comma repair, schema validation, then one
repair round-trip, then a deterministic fallback.

**No AI failure can take down a deterministic agent.** Agents 7-10 report
`degraded`, never `unhealthy`, so a supervisor never restarts one over a model
outage. Check what it is actually doing:

```sh
curl -s localhost:9096/health | jq '.checks[] | select(.name=="ai_provider")'
```

Four failure modes, each with a message you can act on:

| Situation | Reported |
|---|---|
| Working | `healthy` |
| Wrong model name | `degraded` — `provider unusable: ... is not a valid model ID` |
| Bad key | `degraded` — `provider unusable: auth: Authentication failed (401)` |
| `AI_DAILY_CALL_BUDGET=0` | `degraded` — `AI disabled: daily call budget is 0` |

### Docker

Each agent 1-5 also ships a `Dockerfile`, and `agent6/docker-compose.yml` brings up agents 1-5 plus Prometheus and Grafana as containers (isolated networking avoids the port conflicts that the bare-Node path has to work around - see below). This is a separate deployment path from `agent6 npm start`; agents 7-10 aren't in the compose file yet.

## What is real and what is not

This framework was built and tested without router hardware. Some capabilities
measure a real device; some are implemented but unproven against one; and some
return generated data so the surrounding system can be exercised.

Nothing in the third column is hidden at runtime. Every simulated path logs a
`SIMULATED:` warning the first time it runs, marks its result with
`simulated: true`, and is listed by that agent's `/health` endpoint — which
reports `degraded`, never `healthy`, while any simulated path is registered.
Check it before you trust a number:

```sh
curl -s localhost:9093/health | jq '.simulated, .checks[] | select(.name=="simulated_paths")'
```

**Real** — measures an actual device or genuinely processes real input.
**Partial** — implemented, but unverified against real hardware.
**Simulated** — returns generated data. Not a measurement.

| Agent | Capability | Status | Notes |
|---|---|---|---|
| 1 monitoring | SNMP polling (CPU, memory, uptime, interfaces) | Partial | Real SNMP client; needs a device with SNMP enabled |
| 1 monitoring | Syslog ingestion and failed-login detection | Real | Genuinely parses received syslog |
| 1 monitoring | Threshold alerting, dedupe, resolution | Real | |
| 2 resilience | ICMP/SNMP heartbeat | Partial | Real probes; unverified against real failover hardware |
| 2 resilience | **Failover execution** | **Simulated** | Records success; changes no routing state. Needs VRRP/BGP/vendor API |
| 2 resilience | Backup availability / primary stability checks | Simulated | Always return "available" and "stable" |
| 2 resilience | Config fetch and apply via NETCONF/RESTCONF | Simulated | Returns placeholders |
| 3 security | Syslog auth-failure, brute force, spraying and port-scan detection | Real | Rate-based over real received syslog; emits findings agent6 correlates |
| 3 security | SNMP trap ingestion | Partial | |
| 3 security | **Config validation** | **Simulated** | Validates a generated placeholder, not the device config |
| 3 security | Traffic volume analysis | Simulated | Syslog carries no volume data; no volume is now fabricated. Needs NetFlow/sFlow/IPFIX |
| 4 performance | ICMP latency percentiles, RFC 3550 jitter, burst-aware loss | Real | Falls back to generated values only when the host is unreachable |
| 4 performance | SNMP performance counters | Partial | Falls back to generated values when unreachable |
| 4 performance | **QoS class metrics** | **Simulated** | No real collection path exists. Needs CISCO-CLASS-BASED-QOS-MIB |
| 4 performance | Traffic distribution / balancing | Simulated | Needs interface counter deltas or flow data |
| 4 performance | Applying an optimisation | Simulated | Reports applied; configures nothing |
| 5 governance | SNMP-based policy checks | Partial | Real SNMP gets, compared against policy |
| 5 governance | Syslog policy checks | Real | Evaluates real received syslog against a pattern, window and threshold |
| 5 governance | **Configuration policy checks** | **Simulated** | Returns `compliant: null` (not evaluated) - needs NETCONF/RESTCONF |
| 5 governance | Config backup | Partial | |
| 5 governance | Self-healing writes | Real, gated | Genuinely writes SNMP. Off by default, allowlisted, dry-run by default |
| 5 governance | Firmware / CVE check | Simulated | Hardcoded version table, no advisory feed |
| 6 orchestrator | Process supervision, health, config distribution | Real | |
| 6 orchestrator | Cross-agent incident correlation | Real | Deterministic; no API key required |
| 6 orchestrator | Incident history across restarts | Real | SQLite |
| 7–10 AI layer | Correlation, reporting, advice, chat | Real | Real model calls. Quality of input depends on the rows above |

**The consequence worth stating plainly:** where an input is simulated, anything
downstream inherits it. A compliance report from agent 8 that draws on agent 5's
syslog policy checks is narrating a placeholder, and agent 9's remediation advice
for a low agent-4 efficiency score is advice about generated numbers. The
`simulated` flag propagates so you can tell, but the honest summary is that the
AI layer is only as real as what it reads.

Every simulated row is a well-scoped contribution. See CONTRIBUTING.md.

## Safety design

- **Agent9 never executes anything.** Every suggestion/runbook/review it produces carries `requiresHumanApproval: true, autoApply: false` - there is no code path that applies a change automatically.
- **Agent10 gates destructive actions.** Restarting/stopping/starting an agent via chat returns a `pendingAction` requiring an explicit round-trip to `/api/chat/confirm` before anything happens - a natural-language request alone never executes it.
- **Everything degrades gracefully with no real router hardware.** This framework was built and tested without a real router present - SNMP/ICMP timeouts against placeholder IPs are expected and handled (logged, not crashed) throughout. Point `router.yml`'s `primary`/`backup` host and `snmp_community` at real hardware for actual deployment.
- **Change the defaults before real production use:** `router.yml`'s `snmp_community: "public"` and `grafana.admin_password: "admin"` are placeholders, already marked `# CHANGE THIS` in the config.

## Configuration

`agent6/router.yml` is the master config - it sets router IPs/SNMP credentials, per-agent ports, and which agents are enabled, then distributes the relevant slice to each agent's own config on startup. Editing it and restarting the orchestrator is the normal way to reconfigure the framework; you shouldn't need to hand-edit individual agents' configs directly (`agent6` overwrites most of them on every start).

## Known environment quirks (by design, not bugs)

- An agent whose monitored router is unreachable reports `degraded`, not `unhealthy` - the process is working correctly by telling you it cannot see the device. Only a broken process reports `unhealthy`, so a supervisor never restarts an agent over a device outage.
- Free-tier LLM models vary in reliability. The shipped default (`nvidia/nemotron-3-nano-30b-a3b:free`) was picked by measurement, not preference: it returned valid structured output on every attempt at ~1.2s, while larger free models are more oversubscribed and return empty completions under load. Point the framework at any model you like via `OPENROUTER_MODEL` / `AI_MODEL` — agents 7-10 scale with whatever is behind them.

## License

MIT - see `LICENSE`.
