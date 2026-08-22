/**
 * Collector module export
 * Exports all collectors for easy import
 */

const snmpCollector = require('./snmpCollector');
const syslogCollector = require('./syslogCollector');

module.exports = {
  snmpCollector,
  syslogCollector,
};
