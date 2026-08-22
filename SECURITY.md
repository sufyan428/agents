# Security Policy

## Project status

This project is **pre-1.0 and under active hardening**. Treat it as suitable for
lab, test, and evaluation environments. Do not point it at production network
hardware you cannot afford to have misconfigured until 1.0 ships.

## Trust model

Understanding what this framework assumes is the most important part of running
it safely.

**The framework is designed to run on a trusted host, on a loopback or private
management interface.** It is not hardened to be exposed directly to a hostile
network, and it is not multi-tenant.

Specifically:

- **Every HTTP listener binds `127.0.0.1` by default.** If you change
  `BIND_HOST`, you are responsible for putting authentication and TLS in front
  of it — a reverse proxy with client certificates or an authenticating gateway.
- **The orchestrator's control endpoints can start, stop, and restart agents.**
  Anyone who can reach them and holds the API token controls the framework.
- **Agent 2 can trigger a router failover.** Agent 5 can write configuration to
  network devices when `auto_heal` is enabled — it is disabled by default and
  should stay that way unless you have reviewed every healing action.
- **Syslog and SNMP trap listeners accept unauthenticated UDP by protocol
  design.** Restrict them at the network layer to your actual devices. The
  framework applies source allowlisting and rate limits, but UDP source
  addresses are trivially spoofable and cannot be trusted for authorization.
- **The AI layer (agents 7–10) sends operational telemetry to whichever model
  endpoint you configure.** Router hostnames, IP addresses, interface names, and
  syslog content leave your network in that request. Point it at a local model
  if that matters to you. Agents 1–6 make no outbound AI calls under any
  configuration.

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability.

Report it through GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository.

Include the affected agent, a description of the impact, and reproduction steps
if you have them. You will get an acknowledgement within 7 days and an
assessment within 14.

If a report is valid, the fix ships with a credit in the release notes unless
you ask otherwise.

## Scope

**In scope:** authentication bypass, command or code injection, credential
exposure, path traversal, unauthenticated actions against network devices,
denial of service reachable from a device the framework monitors.

**Out of scope:** anything that requires the attacker to already hold the API
token or host access; findings against the bundled router simulator, which is a
test fixture and deliberately trusts its input; missing hardening on an endpoint
you deliberately exposed by changing `BIND_HOST`; dependency advisories with no
reachable call path (report those as regular issues).

## Supported versions

Until 1.0, only the `main` branch receives security fixes.
