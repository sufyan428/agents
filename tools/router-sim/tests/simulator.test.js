// Drives the simulator with the framework's own SNMP client, then injects
// faults and confirms the readings actually move.
const test = require('node:test');
const assert = require('node:assert/strict');
const snmp = require('net-snmp');

const SNMP_PORT = 11661;
const API_PORT = 18090;
const API = `http://127.0.0.1:${API_PORT}`;

process.argv = [
  process.argv[0],
  'sim',
  '--snmp-port',
  String(SNMP_PORT),
  '--api-port',
  String(API_PORT),
];
const sim = require('../src/index.js');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

const session = () =>
  snmp.createSession('127.0.0.1', 'public', {
    port: SNMP_PORT,
    version: snmp.Version2c,
    timeout: 2500,
    retries: 1,
  });

function get(oids) {
  return new Promise((resolve, reject) => {
    const s = session();
    s.get(oids, (err, vb) => {
      s.close();
      err ? reject(err) : resolve(vb);
    });
  });
}
function walk(oid) {
  return new Promise((resolve, reject) => {
    const s = session();
    const rows = [];
    s.subtree(
      oid,
      (vbs) => rows.push(...vbs),
      (err) => {
        s.close();
        err ? reject(err) : resolve(rows);
      },
    );
  });
}
const post = async (p, body) =>
  (
    await fetch(API + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  ).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the simulator answers real SNMP and reacts to injected faults', async () => {
  sim.start();
  await sleep(1200);

  console.log("\nthe framework's own SNMP client can read the simulator");
  const sys = await get(['1.3.6.1.2.1.1.5.0', '1.3.6.1.2.1.1.3.0']);
  check('sysName', String(sys[0].value) === 'sim-router-1', String(sys[0].value));
  check('sysUpTime advances', Number(sys[1].value) > 0, `${sys[1].value} ticks`);

  const cpu = await get(['1.3.6.1.4.1.9.9.109.1.1.1.1.8.1']);
  check('Cisco CPU OID resolves', Number(cpu[0].value) > 0, `${cpu[0].value}%`);

  const mem = await get(['1.3.6.1.4.1.9.9.48.1.1.1.5.1', '1.3.6.1.4.1.9.9.48.1.1.1.6.1']);
  const usedB = Number(mem[0].value),
    freeB = Number(mem[1].value);
  const pct = Math.round((usedB / (usedB + freeB)) * 100);
  check(
    'memory used+free give the right percentage',
    pct >= 38 && pct <= 46,
    `${pct}% used (baseline 41%)`,
  );

  console.log('\nthe interface table walks, which is what agent1 does');
  const ifs = await walk('1.3.6.1.2.1.2.2.1.2');
  check('ifDescr walk returns rows', ifs.length === 3, `${ifs.length} interfaces`);
  const octets = await get(['1.3.6.1.2.1.2.2.1.10.1']);
  const first = Number(octets[0].value);
  await sleep(2500);
  const second = Number((await get(['1.3.6.1.2.1.2.2.1.10.1']))[0].value);
  check('ifInOctets counter increases', second > first, `${first} -> ${second}`);

  console.log('\nfaults change what SNMP reports');
  await post('/fault/cpu_spike', { target: 96, durationMs: 20000 });
  await sleep(1500);
  const spiked = Number((await get(['1.3.6.1.4.1.9.9.109.1.1.1.1.8.1']))[0].value);
  check('cpu_spike raises the CPU reading', spiked >= 90, `${spiked}%`);

  await post('/fault/interface_down', { interface: 2, durationMs: 20000 });
  await sleep(1500);
  const oper = Number((await get(['1.3.6.1.2.1.2.2.1.8.2']))[0].value);
  check('interface_down sets ifOperStatus=2', oper === 2, `status ${oper}`);

  await post('/fault/interface_errors', { interface: 1, errorsPerSec: 50, durationMs: 20000 });
  const e1 = Number((await get(['1.3.6.1.2.1.2.2.1.14.1']))[0].value);
  await sleep(2500);
  const e2 = Number((await get(['1.3.6.1.2.1.2.2.1.14.1']))[0].value);
  check('interface_errors increments ifInErrors', e2 > e1, `${e1} -> ${e2}`);

  console.log('\nfaults clear and the device recovers');
  await post('/faults/clear');
  await sleep(2000);
  const recovered = Number((await get(['1.3.6.1.2.1.2.2.1.8.2']))[0].value);
  check('interface returns to up', recovered === 1, `status ${recovered}`);
  const cpuBack = Number((await get(['1.3.6.1.4.1.9.9.109.1.1.1.1.8.1']))[0].value);
  // Decay is deliberately gradual - a spike should produce a curve that
  // baselining logic can be tested against, not a step back to normal.
  check(
    'CPU is decaying, not stuck at the spike',
    cpuBack < 96 && cpuBack > 22,
    `${cpuBack}% and falling`,
  );

  console.log('\ncontrol API');
  const state = await (await fetch(`${API}/state`)).json();
  check(
    '/state reports the device',
    state.name === 'sim-router-1',
    `${state.interfaces.length} interfaces`,
  );
  const list = await (await fetch(`${API}/faults`)).json();
  check(
    '/faults lists what can be injected',
    list.faults.length >= 8,
    `${list.faults.length} faults`,
  );
  const bad = await post('/fault/does_not_exist');
  check(
    'unknown fault is rejected',
    /Unknown fault/.test(bad.error || ''),
    bad.error?.slice(0, 40),
  );

  sim.stop();

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name} ${c.detail}`);
  assert.equal(failed.length, 0, failed.map((c) => `${c.name} (${c.detail})`).join('; '));
});
