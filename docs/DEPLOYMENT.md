# Deployment

## Try it in two minutes, no hardware

```sh
npm ci
npm run build
npm run sim                                   # terminal 1

cd agent6
export AGENT_API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npm start                                     # terminal 2
```

Wait about thirty seconds, then:

```sh
curl localhost:8080/api/overview              # every agent
curl localhost:9090/metrics/router            # real SNMP data from the simulator
curl localhost:8080/api/incidents             # correlated incidents, no API key needed
```

Break something and watch it react:

```sh
curl -X POST localhost:8090/fault/interface_flap
curl -X POST localhost:8090/fault/cpu_spike -H 'content-type: application/json' -d '{"target":97}'
curl -X POST localhost:8090/faults/clear
```

On Windows `cmd`, use `set AGENT_API_TOKEN=...`; in PowerShell,
`$env:AGENT_API_TOKEN="..."`.

## Docker

```sh
cd agent6
cat > .env <<'EOF'
AGENT_API_TOKEN=<generate one>
GRAFANA_ADMIN_PASSWORD=<choose one>
EOF
docker compose up
```

Brings up the simulator, agents 1–5, Prometheus and Grafana, with every agent
waiting for the simulator to be healthy first.

Compose refuses to start without `AGENT_API_TOKEN` and `GRAFANA_ADMIN_PASSWORD`.
That is deliberate: shipping `admin/admin` as a working default is how
dashboards end up on the public internet.

**Every port publishes to `127.0.0.1` only.** To reach it from another machine,
put a reverse proxy with TLS in front — do not change the binding and hope.

| | |
|---|---|
| Grafana | http://localhost:3000 |
| Prometheus | http://localhost:9095 |
| Orchestrator | http://localhost:8080 |
| Simulator control | http://localhost:8090 |

## Against real hardware

Change one host in `agent6/router.yml`:

```yaml
router:
  primary:
    host: "192.168.1.1"
    snmp_port: 161
    snmp_community: "your-community-string"
```

Then, before you trust anything it tells you:

1. **Read the capability matrix in the README.** Several paths are simulated
   and marked as such. `curl localhost:9093/health` shows which.
2. **Leave self-healing off** until you have run it in dry-run and read what it
   proposed. It writes to devices.
3. **Keep `BIND_HOST` on loopback.** The control plane can stop every agent and
   trigger a failover.
4. **Point Prometheus at the agents' `/metrics/*` paths**, not just `/metrics` —
   the latter is process metrics; the domain data is on the suffixed paths.

## Production checklist

- [ ] `AGENT_API_TOKEN` set to something random, not a placeholder
- [ ] `BIND_HOST` loopback, or a TLS-terminating proxy in front
- [ ] `AGENT_CORS_ORIGINS` empty unless a browser genuinely needs it
- [ ] `ROUTER_TLS_INSECURE` unset
- [ ] SNMP community changed from `public`
- [ ] Grafana password changed
- [ ] `auto_heal` false, or dry-run verified and actions allowlisted
- [ ] `RAGENT_DATA_DIR` on a volume that survives a restart
- [ ] `AI_DAILY_CALL_BUDGET` set to something you are willing to spend
- [ ] Syslog and SNMP-trap ports firewalled to your actual devices — they are
      unauthenticated UDP by protocol design

## Operating it

**Logs** are JSON when stdout is not a terminal. Every record carries a
`correlationId` that follows one incident across all ten processes:

```sh
grep '"correlationId":"c-abc123"' agent*/logs/*.log
```

Secrets are redacted before anything is written.

**State** lives in SQLite under `RAGENT_DATA_DIR`, one file per agent. Findings,
incidents and events survive a restart, so an agent can answer "has this
happened before?" Back that directory up; nothing else holds state.

**Upgrading**: stop the orchestrator, pull, `npm ci && npm run build`, start it
again. Config files are validated on load and a schema change fails loudly
rather than silently.
