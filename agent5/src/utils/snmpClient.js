const snmp = require('net-snmp');
const logger = require('./logger');

class SNMPClient {
  constructor(router) {
    this.router = router;
    this.options = {
      port: router.snmp_port || 161,
      version: this.getSnmpVersion(router.snmp_version),
      community: router.snmp_community,
      timeout: 5000,
      retries: 3
    };
    this.session = null;
  }

  getSnmpVersion(versionStr) {
    switch (versionStr.toLowerCase()) {
      case '1':
        return snmp.Version1;
      case '2c':
      case 'v2c':
        return snmp.Version2c;
      case '3':
        return snmp.Version3;
      default:
        return snmp.Version2c;
    }
  }

  createSession() {
    if (!this.session) {
      this.session = snmp.createSession(
        this.router.host,
        this.options.community,
        this.options
      );
      logger.debug(`Created SNMP session for ${this.router.name} at ${this.router.host}`);
    }
    return this.session;
  }

  async get(oid) {
    return new Promise((resolve, reject) => {
      const session = this.createSession();

      session.get([oid], (error, varbinds) => {
        if (error) {
          logger.error(`SNMP GET failed for ${oid}: ${error.message}`);
          reject(error);
          return;
        }

        if (varbinds.length === 0) {
          reject(new Error('No varbinds returned'));
          return;
        }

        const varbind = varbinds[0];
        if (snmp.isVarbindError(varbind)) {
          reject(new Error(`SNMP varbind error: ${snmp.varbindError(varbind)}`));
          return;
        }

        const value = varbind.value.toString();
        logger.debug(`SNMP GET ${oid} = ${value}`);
        resolve(value);
      });

      session.close();
    });
  }

  async set(oid, value, type = 'OctetString') {
    return new Promise((resolve, reject) => {
      const session = this.createSession();

      const varbind = {
        oid: oid,
        type: this.getSnmpType(type),
        value: value
      };

      session.set([varbind], (error, _varbinds) => {
        if (error) {
          logger.error(`SNMP SET failed for ${oid}: ${error.message}`);
          reject(error);
          return;
        }

        logger.info(`SNMP SET ${oid} = ${value}`);
        resolve({ oid, value, type });
      });

      session.close();
    });
  }

  async walk(oid, maxRepetitions = 20) {
    return new Promise((resolve, reject) => {
      const session = this.createSession();
      const results = [];

      session.walk(oid, maxRepetitions, (varbinds) => {
        for (const varbind of varbinds) {
          if (!snmp.isVarbindError(varbind)) {
            results.push({
              oid: varbind.oid,
              value: varbind.value.toString(),
              type: varbind.type
            });
          }
        }
      }, (error) => {
        if (error) {
          logger.error(`SNMP WALK failed for ${oid}: ${error.message}`);
          reject(error);
          return;
        }

        logger.debug(`SNMP WALK ${oid} returned ${results.length} results`);
        resolve(results);
        session.close();
      });
    });
  }

  async getBulk(oid, nonRepeaters = 0, maxRepetitions = 20) {
    return new Promise((resolve, reject) => {
      const session = this.createSession();

      if (this.options.version === snmp.Version1) {
        // Fall back to walk for SNMPv1
        logger.warn('SNMPv1 does not support GETBULK, using WALK instead');
        return this.walk(oid, maxRepetitions).then(resolve).catch(reject);
      }

      session.getBulk([oid], nonRepeaters, maxRepetitions, (error, varbinds) => {
        if (error) {
          logger.error(`SNMP GETBULK failed for ${oid}: ${error.message}`);
          reject(error);
          return;
        }

        const results = varbinds.map(varbind => ({
          oid: varbind.oid,
          value: varbind.value.toString(),
          type: varbind.type
        }));

        logger.debug(`SNMP GETBULK ${oid} returned ${results.length} results`);
        resolve(results);
        session.close();
      });
    });
  }

  async getTable(tableOid) {
    return new Promise((resolve, reject) => {
      const session = this.createSession();
      const results = [];

      session.table(tableOid, (error, table) => {
        if (error) {
          logger.error(`SNMP TABLE failed for ${tableOid}: ${error.message}`);
          reject(error);
          return;
        }

        // Convert table object to array format
        for (const index in table) {
          results.push({
            index: index,
            columns: table[index]
          });
        }

        logger.debug(`SNMP TABLE ${tableOid} returned ${results.length} rows`);
        resolve(results);
        session.close();
      });
    });
  }

  async getNext(oid) {
    return new Promise((resolve, reject) => {
      const session = this.createSession();

      session.getNext([oid], (error, varbinds) => {
        if (error) {
          logger.error(`SNMP GETNEXT failed for ${oid}: ${error.message}`);
          reject(error);
          return;
        }

        const varbind = varbinds[0];
        if (snmp.isVarbindError(varbind)) {
          reject(new Error(`SNMP varbind error: ${snmp.varbindError(varbind)}`));
          return;
        }

        resolve({
          oid: varbind.oid,
          value: varbind.value.toString()
        });
        session.close();
      });
    });
  }

  getSnmpType(typeStr) {
    const types = {
      'Integer': snmp.ObjectType.Integer,
      'Integer32': snmp.ObjectType.Integer,
      'OctetString': snmp.ObjectType.OctetString,
      'ObjectIdentifier': snmp.ObjectType.ObjectIdentifier,
      'IpAddress': snmp.ObjectType.IpAddress,
      'Counter32': snmp.ObjectType.Counter32,
      'Gauge32': snmp.ObjectType.Gauge32,
      'TimeTicks': snmp.ObjectType.TimeTicks,
      'Opaque': snmp.ObjectType.Opaque,
      'Counter64': snmp.ObjectType.Counter64,
      'Unsigned32': snmp.ObjectType.Unsigned32
    };

    return types[typeStr] || snmp.ObjectType.OctetString;
  }

  close() {
    if (this.session) {
      this.session.close();
      this.session = null;
      logger.debug(`Closed SNMP session for ${this.router.name}`);
    }
  }

  async testConnection() {
    try {
      const sysDescr = await this.get('1.3.6.1.2.1.1.1.0');
      logger.info(`SNMP connection test successful for ${this.router.name}: ${sysDescr.substring(0, 50)}`);
      return {
        success: true,
        sysDescr: sysDescr.substring(0, 100)
      };
    } catch (error) {
      logger.error(`SNMP connection test failed for ${this.router.name}: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = SNMPClient;