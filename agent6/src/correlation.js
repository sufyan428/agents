const CorrelationEngine = require('./correlation-engine');
const agentManager = require('./agent-manager');

// Single shared instance: the gateway serves its snapshot, index.js drives it.
module.exports = new CorrelationEngine(agentManager);
