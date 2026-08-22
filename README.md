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
| 3 security | Syslog auth-failure and port-scan detection | Real | Real parsing of real input |
| 3 security | SNMP trap ingestion | Partial | |
| 3 security | **Config validation** | **Simulated** | Validates a generated placeholder, not the device config |
| 3 security | Traffic volume analysis | Simulated | Syslog carries no volume data; no volume is now fabricated. Needs NetFlow/sFlow/IPFIX |
| 4 performance | ICMP latency / jitter / loss | Real | Falls back to generated values only when unreachable |
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
