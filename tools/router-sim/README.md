# Router simulator

A fake router the framework can actually talk to: a **real SNMP v2c responder**
on a real socket, **real syslog** over UDP, and an HTTP control API for
injecting faults on demand.

```sh
npm start -w @ragent/router-sim
```

## Why this exists

Three reasons, and it is worth having all three in one thing:

**You can run the framework with no hardware.** Point `router.yml` at
`127.0.0.1` and every SNMP code path executes for real.

**Simulated code paths get something real to read.** Several parts of the
framework used to generate data because there was nothing to measure. This
replaces the inputs, so those paths can be implemented properly rather than
faked.

**Faults become repeatable.** You cannot ask a production switch to flap an
interface, spike its CPU, or emit forty failed logins so you can check an alert
fires. Here each is one HTTP call, and it reverts cleanly afterwards. That is
what makes integration tests possible.

## Pointing the framework at it

In `agent6/router.yml`:

```yaml
router:
  primary:
    host: "127.0.0.1"
    snmp_community: "public"
    snmp_port: 1161
```

Then start the orchestrator as usual. The simulator sends syslog to ports
5140, 5142, 5143 and 5144, which is where agents 1, 3, 4 and 5 listen.

## Mixing it with your real router

ICMP needs no credentials, so you can measure a real device while simulating
the rest. Point SNMP at the simulator and ICMP at your actual gateway:

```yaml
router:
  primary:
    host: "127.0.0.1"      # SNMP -> simulator
    snmp_port: 1161
  backup:
    host: "192.168.1.1"    # ICMP -> your real router
```

Unplug the real one and you will watch a genuine heartbeat failure, with real
latency and loss numbers on the way down.

## Control API

Defaults to `127.0.0.1:8090`. No authentication — it is a test fixture, and it
binds loopback for that reason.

| Method | Path | Purpose |
|---|---|---|
| GET | `/state` | Full device state: counters, interfaces, active faults |
| GET | `/health` | Liveness plus which faults are running |
| GET | `/faults` | Every injectable fault, its parameters and defaults |
| POST | `/fault/:name` | Inject a fault. JSON body overrides any parameter |
| DELETE | `/fault/:name` | Clear one fault early |
| POST | `/faults/clear` | Clear everything |
| POST | `/reset` | Clear faults and reset counters and uptime |
| POST | `/syslog` | Emit an arbitrary syslog line: `{"message":"...","severity":4}` |

## Faults

| Fault | Effect | Key parameters |
|---|---|---|
| `interface_flap` | Interface goes down and up repeatedly, with matching syslog | `interface`, `downMs`, `upMs`, `cycles` |
| `interface_down` | Holds an interface down | `interface`, `durationMs` |
| `cpu_spike` | Pins CPU at a target percentage | `target`, `durationMs` |
| `memory_leak` | Memory climbs steadily | `ratePctPerSec`, `durationMs` |
| `interface_errors` | Input errors accumulate | `interface`, `errorsPerSec`, `durationMs` |
| `traffic_surge` | Interface load multiplies | `interface`, `factor`, `durationMs` |
| `auth_failure_burst` | Failed-login syslog from several sources | `count`, `intervalMs`, `sourceCount` |
| `total_loss` | Device stops answering entirely | `durationMs` |

```sh
curl -X POST localhost:8090/fault/interface_flap
curl -X POST localhost:8090/fault/cpu_spike -H 'content-type: application/json' -d '{"target":98}'
curl -X POST localhost:8090/faults/clear
```

## Design notes

**Counters only increase, and wrap at 32 bits** like a real device. Code that
computes deltas has to handle the wrap, and it will never meet that bug against
a device that has been up for five minutes.

**Values are a function of elapsed time plus injected faults**, so a scenario
replays identically. A test that depends on a random walk fails once a
fortnight for no reason anyone can reproduce.

**CPU and memory decay toward baseline** rather than snapping back, so a spike
produces a curve. Threshold logic and statistical baselining need a curve to be
tested meaningfully.

**`ifSpeed` saturates at Gauge32**, as it does on real hardware — which is why
IF-MIB later added `ifHighSpeed`.

## What it does not do

SNMPv3, SNMP SET, NETCONF and RESTCONF are not implemented. The framework's
config-write paths remain simulated until they are, and they are marked as such
at runtime — see the capability matrix in the root README.
