# Architecture

Ten processes watching one network, plus a simulator so the whole thing runs
without hardware.

## The shape of it

```
                            ┌──────────────────────────────┐
                            │   agent6  ORCHESTRATOR       │
   operator ───────────────▶│                              │
   (authenticated)          │  supervises 1-5, 7-10        │
                            │  distributes config          │
                            │  CORRELATES findings ────────┼──▶ /api/incidents
                            └───────┬──────────────┬───────┘     (no API key)
                                    │ spawn        │ GET /api/findings
                    ┌───────────────┴──────┐       │
                    ▼                      ▼       │
        ┌───────────────────────────────────────┐  │
        │  DETERMINISTIC CORE — never calls AI  │  │
        │                                       │  │
        │  agent1  metrics, thresholds,         │◀─┘
        │          baselines, alerting          │
        │  agent2  failover, heartbeat          │
        │  agent3  intrusion detection          │
        │  agent4  latency, jitter, loss, QoS   │
        │  agent5  compliance, backups, healing │
        └───────────────┬───────────────────────┘
                        │ SNMP · syslog · ICMP
                        ▼
              ┌───────────────────┐
              │  router-sim       │   or a real device:
              │  (or real device) │   change one host in router.yml
              └───────────────────┘

        ┌───────────────────────────────────────┐
        │  AI LAYER — optional, BYOK            │
        │                                       │
        │  agent7   narrates agent6's incidents │
        │  agent8   digests agent5's audit data │
        │  agent9   advises; never executes     │
        │  agent10  chat; confirms before acting│
        └───────────────────────────────────────┘
              switch it off and nothing above breaks
```

## The three decisions that shape everything

### Agents 1–6 never make an AI call

Not behind a flag, not as a fallback. The framework detects, correlates, ranks
and explains incidents with no model and no key — `GET /api/incidents` works on
a fresh clone.

This is why correlation lives in **agent6, not agent7**. The orchestrator always
runs; agent7 is optional. Putting correlation behind an API key would mean the
system only becomes coherent once you pay for a model.

The AI layer then does what a model is genuinely better at: turning a
correlated incident into something readable at 3am. It enriches; it does not
compute. When it is unavailable the incident is still there, still ranked — only
the prose is missing.

### Nothing writes to a device without a human deciding

- agent9 has **no execution path at all**. Every output carries
  `requiresHumanApproval: true`.
- agent10 requires an authenticated confirmation round-trip.
- agent5's self-healing is off by default, needs each action named in an
  allowlist, and is dry-run until explicitly disabled. Three gates, all closed.

### Simulated data can never pass as measured

Any code path that produces a result without touching a device registers
itself, warns on first use, marks its output `simulated: true`, and forces that
agent's `/health` to `degraded`. The flag propagates through findings and
incidents, so an AI-written summary of partly-simulated input says so.

The README's capability matrix lists all 24 capabilities as Real, Partial or
Simulated.

## How a fault becomes one incident

```
  simulator: interface_flap on Gi0/0
        │
        ├─▶ agent1  SNMP sees ifOperStatus 2       ──┐
        ├─▶ agent2  heartbeat misses               ──┤
        ├─▶ agent3  syslog LINK-3-UPDOWN           ──┤ each emits a Finding
        ├─▶ agent4  loss and latency rise          ──┤ to its own store
        └─▶ agent5  a policy check fails           ──┘
                            │
                            │ agent6 polls GET /api/findings from each
                            ▼
             group by entity + time window
                            │
                            ▼
             rank by causal layer:
               reachability → link → protocol →
               resources → performance → policy
                            │
                            ▼
             ONE incident, root cause = interface_down,
             five symptoms, confidence 0.85, with the
             reasoning attached
                            │
                            ▼ (only if a key is configured)
             agent7 writes two sentences a human can act on
```

Five alerts become one incident. Paging someone five times for one cause is how
alerting earns the reputation it has.

## Packages

Four shared packages, so behaviour is defined once rather than ten times.

| Package | Holds |
|---|---|
| `@ragent/agent-protocol` | Finding, HealthReport and event schemas. The vocabulary all ten agents share |
| `@ragent/agent-common` | Logger with secret redaction, schema-validated config loader, hardened HTTP server factory, finding store, SQLite persistence, correlation tracing |
| `@ragent/analytics` | EWMA/MAD baselining, hysteresis, flap damping, percentiles, RFC 3550 jitter, burst-aware loss, saturation forecasting, correlation |
| `@ragent/ai-core` | Provider-agnostic LLM client: adapters, retries, budgets, circuit breaker, structured-output parsing |

The HTTP server factory is the reason auth cannot drift: authentication,
binding, CORS, rate limiting, body limits and error redaction are defined once
and every agent gets the same behaviour.

## Health has three states, deliberately

| State | Means | HTTP |
|---|---|---|
| `healthy` | Working | 200 |
| `degraded` | The process is fine; something it depends on is not — an unreachable device, an exhausted AI budget, a simulated code path | **200** |
| `unhealthy` | The process itself is broken | 503 |

Degraded returns **200 on purpose**. Container runtimes restart on a failing
health check, and restarting an agent because the router it watches went down
turns one outage into two.

## Ports

| Port | What |
|---|---|
| 8080 | Orchestrator API |
| 9090–9094 | agents 1–5 |
| 9095 | Prometheus |
| 9096–9099 | agents 7–10 |
| 8090 | Simulator control API |
| 1161/udp | Simulator SNMP |
| 5140–5144/udp | Syslog listeners (unprivileged; 514 needs root) |
| 3000 | Grafana |

Everything binds `127.0.0.1` unless `BIND_HOST` says otherwise. See
[SECURITY.md](../SECURITY.md) for the trust model.
