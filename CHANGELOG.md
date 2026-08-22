# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-22

First public release. The framework existed before this in a form that ran, but
was not safe to publish: no authentication on any control endpoint, 67
dependency advisories, and several code paths that returned generated data
indistinguishable from measurements.

### Security

- **Every control endpoint now requires authentication**, and fails *closed*
  when no token is configured — an unconfigured deployment is inert, not
  exposed. Previously an anonymous POST could stop every agent or trigger a
  router failover from anywhere on the network.
- All listeners bind `127.0.0.1` by default; `0.0.0.0` is opt-in and warns.
- Removed a hardcoded SNMP community string that was written to live devices
  (CWE-798). It was also writing to a read-only counter, so it was wrong on its
  own terms.
- TLS certificate verification is on by default. Two code paths sent RESTCONF
  admin credentials with verification disabled.
- Self-healing is off by default behind three independent gates: enable,
  per-action allowlist, and dry-run.
- 67 dependency advisories to zero. Four of the worst came from packages that
  were declared but never imported.
- Fixed a Prometheus cardinality bomb: an attacker-controlled syslog source IP
  was used as a metric label.
- Escaped HTML in alert emails and stripped CR/LF from the Subject header.
- Docker images run as a non-root user; Compose publishes to loopback only and
  refuses to start without a token and a Grafana password.

### Added

- **Router simulator** (`npm run sim`) — a real SNMP v2c responder, real syslog,
  and eight injectable faults. Lets the framework run and be tested with no
  hardware, and makes faults repeatable that cannot be produced on demand
  against a real device.
- **Deterministic correlation** in the orchestrator. Five agents reporting one
  outage become one incident with a ranked root cause and stated reasoning,
  served at `/api/incidents` with **no API key required**.
- **Statistical baselining** — EWMA and MAD per router per metric, catching both
  cases a fixed threshold gets wrong: a device that idles at 22% is flagged at
  60%, and one that always sits at 78% is not flagged for sitting at 79%.
- **Hysteresis and flap damping** everywhere an alarm can oscillate.
- **Alert deduplication.** An hour of a sustained condition now sends 5
  notifications instead of 120.
- **SQLite persistence** for findings, incidents and events, so a restart is no
  longer total amnesia and the framework can answer "has this happened before?"
- **Correlation IDs** that follow one incident across all ten processes,
  including outbound calls between agents.
- **Runtime honesty**: every simulated code path warns on first use, marks its
  output `simulated: true`, and forces that agent's health to `degraded`. The
  README lists all 24 capabilities as Real, Partial or Simulated.
- Four shared packages so behaviour is defined once: `agent-protocol`,
  `agent-common`, `analytics`, `ai-core`.
- 266 tests, ESLint and Prettier, and CI running lint, tests on Node 20 and 22,
  a dependency audit, and an end-to-end boot against the simulator.

### Changed

- **The AI layer is provider-agnostic.** Three values — key, model, base URL —
  and any OpenAI-compatible endpoint works: OpenRouter, Gemini, Together,
  Ollama, vLLM. The framework maintains no model allowlist.
- **agent7 narrates rather than correlates.** It previously handed a raw
  snapshot to a model and asked what was related, which duplicated the
  orchestrator's work and put the framework's ability to make sense of itself
  behind an API key.
- Agent-to-agent AI code is shared, not copied: twelve duplicated files removed.
- Latency is reported as percentiles rather than a mean; jitter follows RFC
  3550; packet loss distinguishes bursts from scatter.
- agent3's authentication monitoring is rate-based and detects password
  spraying, which per-source thresholds are designed to miss.
- Health has three states. `degraded` returns **200**, so a container runtime
  never restarts an agent because the router it watches went down.
- Docs consolidated from 31 files to six plus a short README per agent.

### Fixed

Several of these had never worked and could not have, which is worth stating
plainly:

- **agent1 had never exported a single router metric.** Its collector captured
  OIDs at module load, before config was read, so every lookup was `undefined`.
  It logged "metrics collected successfully" on every poll while exporting
  nothing.
- **agent4 crashed on its first poll against any working SNMP device**, from a
  callback-arity mistake. It had only ever been pointed at an address that timed
  out.
- **The orchestrator could not start any agent on Windows** after a security
  fix, because Node refuses to spawn `.cmd` without a shell. It now runs `node`
  directly on each entry point.
- **agent2 started its heartbeat twice**, so two loops ran concurrently, every
  failover was handled twice, and `stop()` could only cancel one.
- **Stopping an agent restarted it** five seconds later: the exit-code guard
  treated a SIGTERM exit as a crash.
- Memory utilisation was computed against `ciscoMemoryPoolLargestFree`, which is
  not a total. A device at 41% reported 69%.
- agent1 sent the literal string `undefined.1` to devices as an SNMP OID.
- `https` was never imported in agent2's config sync, so every RESTCONF call
  would have thrown.
- `POST /config/reload` returned success and did nothing. It now returns 501.
- Invented CVE identifiers (`CVE-2024-XXXX`) removed from firmware reporting.
- Random byte counts are no longer fed into traffic anomaly detection.

### Known limitations

- **Not validated against real hardware.** Everything is tested against the
  bundled simulator. Anyone with real routers is exactly the contributor this
  project needs.
- SNMPv3, SNMP SET, NETCONF and RESTCONF are not implemented in the simulator,
  so the config-write paths remain simulated and are marked as such.
- QoS metrics, failover execution, and configuration policy checks are
  simulated. See the capability matrix.
- Cisco-oriented OIDs. Other vendors need their own mappings.

[1.0.0]: https://github.com/sufiyansrepos/router-agent-framework/releases/tag/v1.0.0
