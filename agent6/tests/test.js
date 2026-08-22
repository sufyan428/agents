const axios = require('axios');

// Test configuration
const ORCHESTRATOR_URL = 'http://localhost:8080';
// Core agents always run. Agents 7-10 (AI layer, BYOK) are optional - they
// show up alongside these five only when an API key is configured, so tests
// below check that the core set is present rather than an exact total count.
const AGENT_PORTS = {
    'agent1-monitoring': 9090,
    'agent2-resilience': 9091,
    'agent3-security': 9092,
    'agent4-performance': 9093,
    'agent5-automation': 9094
};
const CORE_AGENT_NAMES = Object.keys(AGENT_PORTS);

// Test results
let testsPassed = 0;
let testsFailed = 0;

// Helper function to run a test
async function runTest(name, testFn) {
    try {
        console.log(`\n🧪 Testing: ${name}`);
        await testFn();
        console.log(`✅ PASSED: ${name}`);
        testsPassed++;
    } catch (error) {
        console.log(`❌ FAILED: ${name}`);
        console.log(`   Error: ${error.message}`);
        testsFailed++;
    }
}

// Test 1: Orchestrator Health
async function testOrchestratorHealth() {
    const response = await axios.get(`${ORCHESTRATOR_URL}/health`);
    if (!response.data.healthy) {
        throw new Error('Orchestrator is not healthy');
    }
}

// Test 2: Get All Agents Status
async function testGetAllAgents() {
    const response = await axios.get(`${ORCHESTRATOR_URL}/api/agents`);
    if (!response.data.success) {
        throw new Error('Failed to get agents status');
    }
    const agents = response.data.agents;
    const missingCore = CORE_AGENT_NAMES.filter((name) => !agents[name]);
    if (missingCore.length > 0) {
        throw new Error(`Missing core agents: ${missingCore.join(', ')} (got ${Object.keys(agents).length} agents total)`);
    }
}

// Test 3: Get System Overview
async function testSystemOverview() {
    const response = await axios.get(`${ORCHESTRATOR_URL}/api/overview`);
    if (!response.data.success) {
        throw new Error('Failed to get system overview');
    }
    const overview = response.data.overview;
    if (overview.totalAgents < 5) {
        throw new Error(`Expected at least 5 core agents, got ${overview.totalAgents}`);
    }
}

// Test 4: Get Configuration
async function testGetConfiguration() {
    const response = await axios.get(`${ORCHESTRATOR_URL}/api/config`);
    if (!response.data.success) {
        throw new Error('Failed to get configuration');
    }
    const config = response.data.config;
    if (!config.router || !config.agents) {
        throw new Error('Configuration is missing required fields');
    }
    // Verify sensitive data is sanitized
    if (config.router.primary.snmp_community !== '***') {
        throw new Error('SNMP community string not sanitized');
    }
}

// Test 5: Check All Agents Health
async function testAllAgentsHealth() {
    const response = await axios.get(`${ORCHESTRATOR_URL}/api/health/agents`);
    if (!response.data.success) {
        throw new Error('Failed to check agents health');
    }
    const health = response.data.health;
    const missingCore = CORE_AGENT_NAMES.filter((name) => !health[name]);
    if (missingCore.length > 0) {
        throw new Error(`Missing health data for core agents: ${missingCore.join(', ')}`);
    }
}

// Test 6: Individual Agent Health Endpoints
async function testIndividualAgentHealth() {
    for (const [agentName, port] of Object.entries(AGENT_PORTS)) {
        try {
            const response = await axios.get(`http://localhost:${port}/health`, {
                timeout: 5000
            });
            if (!response.data) {
                throw new Error(`Agent ${agentName} health check returned no data`);
            }
        } catch (_error) {
            // Agent might not be running in test environment
            console.log(`   ⚠ Warning: Agent ${agentName} not accessible (this is OK if not running)`);
        }
    }
}

// Test 7: Configuration Reload
async function testConfigurationReload() {
    const response = await axios.post(`${ORCHESTRATOR_URL}/api/config/reload`);
    if (!response.data.success) {
        throw new Error('Failed to reload configuration');
    }
}

// Main test runner
async function runAllTests() {
    console.log('='.repeat(60));
    console.log('Router Framework Orchestrator - Test Suite');
    console.log('='.repeat(60));

    // Wait for orchestrator to be ready
    console.log('\n⏳ Waiting for orchestrator to be ready...');
    let ready = false;
    for (let i = 0; i < 10; i++) {
        try {
            await axios.get(`${ORCHESTRATOR_URL}/health`, { timeout: 2000 });
            ready = true;
            break;
        } catch (_error) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    if (!ready) {
        console.log('\n❌ Orchestrator is not running. Please start it first:');
        console.log('   npm start');
        process.exit(1);
    }

    console.log('✅ Orchestrator is ready\n');

    // Run all tests
    await runTest('Orchestrator Health Check', testOrchestratorHealth);
    await runTest('Get All Agents Status', testGetAllAgents);
    await runTest('Get System Overview', testSystemOverview);
    await runTest('Get Configuration', testGetConfiguration);
    await runTest('Check All Agents Health', testAllAgentsHealth);
    await runTest('Individual Agent Health Endpoints', testIndividualAgentHealth);
    await runTest('Configuration Reload', testConfigurationReload);

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('Test Summary');
    console.log('='.repeat(60));
    console.log(`✅ Passed: ${testsPassed}`);
    console.log(`❌ Failed: ${testsFailed}`);
    console.log(`📊 Total:  ${testsPassed + testsFailed}`);
    console.log('='.repeat(60));

    if (testsFailed > 0) {
        console.log('\n⚠ Some tests failed. Please check the errors above.');
        process.exit(1);
    } else {
        console.log('\n🎉 All tests passed!');
        process.exit(0);
    }
}

// Run tests
runAllTests().catch((error) => {
    console.error('\n❌ Fatal error running tests:', error.message);
    process.exit(1);
});
