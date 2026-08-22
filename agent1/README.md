# agent1 — Monitoring

SNMP metric collection, syslog ingestion, statistical baselining and threshold alerting.

**Never makes an AI call.** Part of the deterministic core.

Default port: `9090` (loopback).

## Endpoints

| Path | Purpose |
|---|---|
| `/health` | Liveness plus per-check detail, including any simulated paths |
| `/metrics` | Process metrics |
| `/api/findings` | Normalized findings, polled by agent6 for correlation |

## Running it

Normally the orchestrator starts this agent for you:

```sh
cd agent6 && npm start
```

Standalone, for development:

```sh
npm start -w agent1
```

## Documentation

Install, configuration and deployment are documented once for the whole
framework rather than repeated per agent:

- [README](../README.md) — what the framework is, and the capability matrix
- [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) — every setting
- [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) — running it for real
- [SECURITY.md](../SECURITY.md) — trust model and reporting
