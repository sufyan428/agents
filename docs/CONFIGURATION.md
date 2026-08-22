# Configuration

One master file plus environment variables. Everything else is generated.

## agent6/router.yml is the source of truth

The orchestrator reads it, validates it against a schema, and distributes the
relevant slice to each agent on startup. **Do not hand-edit the per-agent
configs** — agent6 rewrites them when they change, keeping a `.bak` of what it
replaced.

Validation runs before anything else reads it, so a mistake names itself:

```
Invalid configuration in agent6/router.yml:
  router.primary.host  ->  required, but missing
```

Two cross-field checks catch failures that are otherwise silent: two enabled
agents claiming the same port (an `EADDRINUSE` deep inside whichever loses the
race, seconds after startup), and a backup router configured with the same host
as the primary — which would "fail over" to the device that just failed.

## Pointing at a device

Ships pointed at the bundled simulator, so a fresh clone works:

```yaml
router:
  primary:
    host: "127.0.0.1"
    snmp_port: 1161          # the simulator. Real devices use 161
    snmp_community: "public"
    snmp_version: "2c"
```

For a real device, change `host`, `snmp_port` and `snmp_community`. Nothing else
moves.

**A real router with no admin access still gives you something.** ICMP needs no
credentials, so pointing `backup.host` at your gateway gets agent2's heartbeat
and agent4's latency, jitter and loss measuring an actual device. SNMP against
it will fail and be reported as unreachable, which is honest and harmless.

## Environment variables

Environment always beats the file.

### Control-plane auth — required

```sh
AGENT_API_TOKEN=...     # generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Without it, every route that starts, stops or restarts an agent, triggers a
failover, or reloads config refuses with **503**. That is deliberate: an
unconfigured deployment is inert, not exposed.

### Binding

```sh
BIND_HOST=127.0.0.1     # default. Anything else needs auth and TLS in front
AGENT_CORS_ORIGINS=     # comma-separated. Empty = no cross-origin access
```

### The AI layer — optional

```sh
AI_API_KEY=...
AI_MODEL=nvidia/nemotron-3-nano-30b-a3b:free
AI_BASE_URL=https://openrouter.ai/api/v1
AI_DAILY_CALL_BUDGET=500      # 0 disables the AI layer entirely
AI_DAILY_TOKEN_BUDGET=0       # 0 = no token limit
```

Any OpenAI-compatible endpoint. See the README for the endpoint table.

### Storage and alerting

```sh
RAGENT_DATA_DIR=./data          # SQLite lives here; created if absent
ALERT_COOLDOWN_MS=900000        # 15m. How long a steady condition stays quiet
ALERT_RESOLVE_AFTER_MS=300000   # 5m of silence before a condition is resolved
LOG_LEVEL=info
```

### Deliberately dangerous, off by default

```sh
ROUTER_TLS_INSECURE=true   # disables certificate verification on RESTCONF
```

That request carries router admin credentials. Turning this on hands them to
anyone able to intercept the connection. Lab use only; it logs a loud warning.

## Self-healing: three gates, all closed

agent5 can write configuration to live hardware. It will not, unless you open
all three:

```yaml
# agent6/router.yml
agents:
  automation:
    auto_heal: false          # gate 1
```

```yaml
# agent5/config.yml
self_healing:
  dry_run: true               # gate 2 - logs what it would do, does nothing
  allowed_actions: []         # gate 3 - each action opted into by name
```

Dry run first. Read the logs. Then decide.

## Thresholds and baselines

`agent1/config/thresholds.yml` holds fixed thresholds, which express operator
intent — a device at 98% CPU is in trouble whatever its history says.

Alongside them the framework learns a baseline per router per metric and flags
departures from it. That catches both cases a fixed line gets wrong: a router
that idles at 22% is in trouble at 60% and no threshold fires, while one that
always sits at 78% would page somebody every poll forever.

Baselines need about 12 samples (six minutes at the default poll) before they
report anything. Nothing is called anomalous before then.

## Turning agents on and off

In `router.yml`:

```yaml
agents:
  chatops:
    enabled: false
```

Or at runtime:

```sh
curl -X POST -H "Authorization: Bearer $AGENT_API_TOKEN" \
  localhost:8080/api/agents/agent10-chatops/disable
```

A disabled agent is **deliberately absent**, not broken: health monitoring stops
flagging it, `start-all` skips it, auto-restart will not resurrect it, and
agent7 does not treat its absence as an anomaly worth a model call. Every agent
runs correctly with any subset of its peers switched off.
