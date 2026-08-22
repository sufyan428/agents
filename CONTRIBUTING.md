# Contributing

Thanks for looking at this. The most useful contributions right now are listed
at the bottom — real device integrations are the biggest gap and the easiest
place to have impact.

## Repository shape

Ten independent Node projects, one per agent. Each has its own
`package.json`, its own dependencies, and its own tests. There is no shared
build step yet.

```
agent1   monitoring              SNMP/syslog metrics
agent2   resilience/failover     primary/backup failover
agent3   security/IDS            intrusion detection
agent4   performance             QoS, latency, jitter, loss
agent5   automation/governance   compliance, backups, self-healing
agent6   orchestrator            process supervision + API gateway
agent7   correlation             cross-agent incident correlation   (AI, optional)
agent8   reporting               narrated digests                   (AI, optional)
agent9   remediation advisor     suggest-only, never executes       (AI, optional)
agent10  chatops                 natural-language interface         (AI, optional)
```

## Getting set up

```sh
# install everything
for d in agent1 agent2 agent3 agent4 agent5 agent6 agent7 agent8 agent9 agent10; do
  (cd "$d" && npm ci)
done

# run one agent's tests
cd agent7 && npm test

# boot the framework (orchestrator spawns agents 1-5, plus 7-10 if a key is set)
cd agent6 && npm start
```

You do **not** need router hardware. The framework is developed against a
simulator and degrades gracefully with unreachable devices.

You do **not** need an AI API key. Agents 1–6 have zero AI dependency and are
the majority of the codebase.

## Two rules that are not negotiable

These are architectural commitments, not preferences. A PR that breaks either
will be asked to change regardless of how good the rest of it is.

**1. Agents 1–6 never make an AI API call.** Not behind a flag, not as a
fallback, not "just for this one feature". The guarantee that the core runs with
zero external AI dependency is the point of the design. Intelligence in agents
1–6 is statistical and deterministic. If a feature genuinely needs a model,
it belongs in agent 7–10 as enrichment layered on top.

**2. Nothing writes to a network device without an explicit human decision.**
Agent 9 is suggest-only and has no execution path. Agent 10 requires a
confirmation round-trip. Agent 5's self-healing is opt-in, allowlisted, and
supports dry-run. Adding an "apply automatically" convenience shortcut is not a
contribution we want.

## Code expectations

- Node 18+. No transpiler, no framework — plain CommonJS as the codebase uses today.
- Match the style of the file you are editing. A repo-wide lint config lands soon;
  until then, consistency within a file beats consistency with your own habits.
- Any behaviour that a test could catch should have one. Pure logic especially —
  those tests are fast and they are the ones that catch regressions.
- **No stubs that report success.** If something is not implemented, it must not
  return `{ success: true }`. Return an explicit not-implemented result, mark it
  `simulated: true`, or throw. Silent fake results are the single worst failure
  mode for a monitoring tool and the repo has been burned by them before.

## Commits and PRs

- Conventional Commits: `fix(agent2): stop heartbeat starting twice`
- One logical change per PR. A refactor and a bugfix in the same diff is two PRs.
- Say what you tested and how. "Ran against the simulator with an interface-flap
  injection" is worth more than "tested locally".
- Never commit a `.env`, an API key, a log file, or anything under `data/`.

## Where help is most wanted

- **Real device integrations.** Several code paths are marked `simulated: true`
  and documented as such in the README's capability matrix — NETCONF and
  RESTCONF config fetch, real failover execution (VRRP/BGP), firmware version
  checks. Each is a well-bounded, self-contained piece of work.
- **Vendor support beyond Cisco.** OID maps and config parsers for Juniper,
  MikroTik, Arista.
- **SNMPv3.** Currently v2c only, which is a real limitation for anyone serious.
- **Grafana dashboards.** The metrics exist; good dashboards for them do not.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
