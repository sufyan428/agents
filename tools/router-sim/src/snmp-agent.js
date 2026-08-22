const snmp = require('net-snmp');

/**
 * A real SNMP v2c responder backed by the simulated device.
 *
 * Serves the exact OIDs this framework queries, which is the point: agent1's
 * collector, agent4's SNMP monitor and agent5's policy checker all issue real
 * SNMP against a real socket here, so their SNMP code paths are genuinely
 * exercised rather than skipped.
 *
 * Three things about net-snmp's agent cost real time to discover, so they are
 * written down here:
 *
 *   A provider without an explicit `maxAccess` defaults to not-accessible, and
 *   every GET against it returns NoAccess with no hint why.
 *
 *   Scalar providers always append `.0` to form the instance. The Cisco CPU and
 *   memory OIDs this framework uses are not scalars - they are columns of
 *   single-row tables - so registering them as scalars puts them one level too
 *   deep and they never resolve.
 *
 *   A table must be registered once for the whole entry, with its real column
 *   numbers. Registering each column as its own table yields
 *   <base>.<col>.<idx> where the real OID is <base>.<idx>.
 *
 * Authorization is deliberately off: this is a test fixture that should accept
 * whatever community string a developer already has configured. It is out of
 * scope for security reporting - see SECURITY.md.
 */

const RO = () => snmp.MaxAccess['read-only'];
const NA = () => snmp.MaxAccess['not-accessible'];

class SnmpAgent {
  constructor(device, { port = 1161, community = 'public', logger = console } = {}) {
    this.device = device;
    this.port = port;
    this.community = community;
    this.logger = logger;
    this.agent = null;
    this.refresh = null;
    this.rowsCreated = false;
  }

  start() {
    const mib = snmp.createMib();
    this.mib = mib;

    const scalar = (name, oid, scalarType) =>
      mib.registerProvider({
        name, oid, type: snmp.MibProviderType.Scalar, scalarType, maxAccess: RO(),
      });

    // ---- system group (real scalars, so .0 is correct) ------------------
    scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString);
    scalar('sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks);
    scalar('sysContact', '1.3.6.1.2.1.1.4', snmp.ObjectType.OctetString);
    scalar('sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString);
    scalar('sysLocation', '1.3.6.1.2.1.1.6', snmp.ObjectType.OctetString);

    // ---- IF-MIB ifTable, one provider, real column numbers ---------------
    // Queried as 1.3.6.1.2.1.2.2.1.<column>.<ifIndex>
    mib.registerProvider({
      name: 'ifEntry',
      oid: '1.3.6.1.2.1.2.2.1',
      type: snmp.MibProviderType.Table,
      maxAccess: RO(),
      tableColumns: [
        { number: 1,  name: 'ifIndex',       type: snmp.ObjectType.Integer,     maxAccess: RO() },
        { number: 2,  name: 'ifDescr',       type: snmp.ObjectType.OctetString, maxAccess: RO() },
        { number: 3,  name: 'ifType',        type: snmp.ObjectType.Integer,     maxAccess: RO() },
        { number: 5,  name: 'ifSpeed',       type: snmp.ObjectType.Gauge,       maxAccess: RO() },
        { number: 7,  name: 'ifAdminStatus', type: snmp.ObjectType.Integer,     maxAccess: RO() },
        { number: 8,  name: 'ifOperStatus',  type: snmp.ObjectType.Integer,     maxAccess: RO() },
        { number: 10, name: 'ifInOctets',    type: snmp.ObjectType.Counter,     maxAccess: RO() },
        { number: 14, name: 'ifInErrors',    type: snmp.ObjectType.Counter,     maxAccess: RO() },
        { number: 16, name: 'ifOutOctets',   type: snmp.ObjectType.Counter,     maxAccess: RO() },
        { number: 20, name: 'ifOutErrors',   type: snmp.ObjectType.Counter,     maxAccess: RO() },
      ],
      tableIndex: [{ columnName: 'ifIndex' }],
    });

    // ---- CISCO-PROCESS-MIB cpmCPUTotalTable (single row, index 1) --------
    // Queried as 1.3.6.1.4.1.9.9.109.1.1.1.1.8.1
    mib.registerProvider({
      name: 'cpmCPUTotalEntry',
      oid: '1.3.6.1.4.1.9.9.109.1.1.1.1',
      type: snmp.MibProviderType.Table,
      maxAccess: RO(),
      tableColumns: [
        { number: 1, name: 'cpmCPUTotalIndex',    type: snmp.ObjectType.Integer, maxAccess: NA() },
        { number: 8, name: 'cpmCPUTotal5secRev',  type: snmp.ObjectType.Gauge,   maxAccess: RO() },
        { number: 7, name: 'cpmCPUTotal1minRev',  type: snmp.ObjectType.Gauge,   maxAccess: RO() },
      ],
      tableIndex: [{ columnName: 'cpmCPUTotalIndex' }],
    });

    // ---- CISCO-MEMORY-POOL-MIB (single row, index 1) ---------------------
    // Queried as 1.3.6.1.4.1.9.9.48.1.1.1.{5,6,7}.1
    mib.registerProvider({
      name: 'ciscoMemoryPoolEntry',
      oid: '1.3.6.1.4.1.9.9.48.1.1.1',
      type: snmp.MibProviderType.Table,
      maxAccess: RO(),
      tableColumns: [
        { number: 1, name: 'ciscoMemoryPoolType',  type: snmp.ObjectType.Integer,     maxAccess: NA() },
        { number: 2, name: 'ciscoMemoryPoolName',  type: snmp.ObjectType.OctetString, maxAccess: RO() },
        { number: 5, name: 'ciscoMemoryPoolUsed',  type: snmp.ObjectType.Gauge,       maxAccess: RO() },
        { number: 6, name: 'ciscoMemoryPoolFree',  type: snmp.ObjectType.Gauge,       maxAccess: RO() },
        { number: 7, name: 'ciscoMemoryPoolLargestFree', type: snmp.ObjectType.Gauge, maxAccess: RO() },
      ],
      tableIndex: [{ columnName: 'ciscoMemoryPoolType' }],
    });

    this.agent = snmp.createAgent(
      { port: this.port, disableAuthorization: true },
      (error) => { if (error) this.logger.error(`SNMP agent error: ${error.message}`); },
      mib,
    );
    this.agent.getAuthorizer().addCommunity(this.community);

    this.sync();
    // The MIB stores values rather than callbacks, so it is refreshed on a
    // timer finer than any poll interval the framework uses.
    this.refresh = setInterval(() => this.sync(), 1000);
    this.refresh.unref?.();

    this.logger.info(`SNMP v2c responder on udp/${this.port} (community "${this.community}")`);
    return this;
  }

  /** Creates the table rows once, then updates cells in place. */
  ensureRows() {
    if (this.rowsCreated) return;
    // ifSpeed is a Gauge32, so anything at or above ~4.29 Gbps overflows it.
    // Real devices hit this too - it is why IF-MIB later added ifHighSpeed -
    // and they report the saturated value rather than failing the request.
    const GAUGE32_MAX = 4294967295;
    for (const i of this.device.interfaces) {
      const speed = Math.min(i.speedBps, GAUGE32_MAX);
      // ifIndex, ifDescr, ifType(6=ethernetCsmacd), ifSpeed, admin, oper, in, inErr, out, outErr
      this.mib.addTableRow('ifEntry', [i.index, i.name, 6, speed, 1, 1, 0, 0, 0, 0]);
    }
    this.mib.addTableRow('cpmCPUTotalEntry', [1, 0, 0]);
    this.mib.addTableRow('ciscoMemoryPoolEntry', [1, 'Processor', 0, 0, 0]);
    this.rowsCreated = true;
  }

  /** Copies current device state into the MIB. */
  sync() {
    if (!this.mib) return;
    const d = this.device;
    d.tick();

    // While unreachable the MIB is left stale; the control API also refuses,
    // so probes behave as they would against a device that lost power.
    if (d.unreachable) return;

    this.ensureRows();

    this.mib.setScalarValue('sysDescr', d.description);
    this.mib.setScalarValue('sysUpTime', d.uptimeTicks);
    this.mib.setScalarValue('sysContact', d.contact);
    this.mib.setScalarValue('sysName', d.name);
    this.mib.setScalarValue('sysLocation', d.location);

    const cell = (provider, column, index, value) => {
      try { this.mib.setTableSingleCell(provider, column, [index], value); }
      catch (e) { this.logger.debug?.(`cell ${provider}.${column}.${index}: ${e.message}`); }
    };

    cell('cpmCPUTotalEntry', 8, 1, Math.round(d.cpu));
    cell('cpmCPUTotalEntry', 7, 1, Math.round(d.cpu));

    const used = d.memoryUsedBytes;
    const free = d.memoryTotalBytes - used;
    cell('ciscoMemoryPoolEntry', 5, 1, used);
    cell('ciscoMemoryPoolEntry', 6, 1, free);
    cell('ciscoMemoryPoolEntry', 7, 1, free);

    for (const i of d.interfaces) {
      cell('ifEntry', 7, i.index, i.adminStatus);
      cell('ifEntry', 8, i.index, i.operStatus);
      cell('ifEntry', 10, i.index, i.inOctets);
      cell('ifEntry', 14, i.index, i.inErrors);
      cell('ifEntry', 16, i.index, i.outOctets);
    }
  }

  stop() {
    if (this.refresh) clearInterval(this.refresh);
    try { this.agent?.close?.(); } catch { /* already closed */ }
  }
}

module.exports = { SnmpAgent };
