/**
 * Local Simulation Script for Security & Intrusion Detection Agent
 * 
 * This script simulates various security events to test the agent's
 * detection capabilities without connecting to a real router.
 */

const dgram = require('dgram');

class SecuritySimulation {
  constructor() {
    this.syslogClient = dgram.createSocket('udp4');
    this.syslogHost = 'localhost';
    this.syslogPort = 514;
  }

  /**
   * Send a syslog message to the agent
   */
  sendSyslogMessage(message) {
    const buffer = Buffer.from(message);
    this.syslogClient.send(buffer, 0, buffer.length, this.syslogPort, this.syslogHost, (err) => {
      if (err) {
        console.error('Error sending syslog:', err);
      } else {
        console.log(`✓ Sent: ${message.substring(0, 80)}...`);
      }
    });
  }

  /**
   * Simulate failed login attempts
   */
  simulateFailedLogins(count = 5) {
    console.log(`\n=== Simulating ${count} Failed Login Attempts ===`);
    const username = 'admin';
    const sourceIp = '192.168.1.100';

    for (let i = 1; i <= count; i++) {
      setTimeout(() => {
        const message = `<34>Jan 1 00:00:0${i} router sshd[12345]: Failed password for ${username} from ${sourceIp} port 22 ssh2`;
        this.sendSyslogMessage(message);
      }, i * 500);
    }
  }

  /**
   * Simulate successful login
   */
  simulateSuccessfulLogin() {
    console.log('\n=== Simulating Successful Login ===');
    const username = 'admin';
    const sourceIp = '192.168.1.50';
    const message = `<30>Jan 1 00:00:10 router sshd[12346]: Accepted password for ${username} from ${sourceIp} port 22 ssh2`;
    this.sendSyslogMessage(message);
  }

  /**
   * Simulate account lockout
   */
  simulateAccountLockout() {
    console.log('\n=== Simulating Account Lockout ===');
    const username = 'testuser';
    const message = `<30>Jan 1 00:00:15 router sshd[12347]: Account locked for user ${username} due to excessive failed attempts`;
    this.sendSyslogMessage(message);
  }

  /**
   * Simulate unauthorized access attempt
   */
  simulateUnauthorizedAccess() {
    console.log('\n=== Simulating Unauthorized Access Attempt ===');
    const sourceIp = '10.0.0.100';
    const message = `<30>Jan 1 00:00:20 router kernel: [1234.567890] SECURITY ALERT: Unauthorized access attempt from ${sourceIp} to management interface`;
    this.sendSyslogMessage(message);
  }

  /**
   * Simulate ACL violation
   */
  simulateAclViolation() {
    console.log('\n=== Simulating ACL Violation ===');
    const sourceIp = '192.168.1.200';
    const aclName = 'MGMT-ACL';
    const message = `<34>Jan 1 00:00:25 router kernel: [1234.567890] ACL violation: ACL=${aclName} SRC=${sourceIp} DST=10.0.0.1 PROTO=TCP DPT=22 action=deny`;
    this.sendSyslogMessage(message);
  }

  /**
   * Simulate port scanning
   */
  simulatePortScan() {
    console.log('\n=== Simulating Port Scanning ===');
    const sourceIp = '172.16.0.50';
    const ports = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 993, 995, 3306, 3389];

    ports.forEach((port, index) => {
      setTimeout(() => {
        const message = `<30>Jan 1 00:00:3${index} router kernel: [1234.567890] Connection attempt from ${sourceIp} to port ${port} blocked`;
        this.sendSyslogMessage(message);
      }, index * 200);
    });
  }

  /**
   * Simulate privilege escalation attempt
   */
  simulatePrivilegeEscalation() {
    console.log('\n=== Simulating Privilege Escalation Attempt ===');
    const username = 'lowprivuser';
    const sourceIp = '192.168.1.150';
    const message = `<30>Jan 1 00:00:50 router sudo[12348]: ${username} : TTY=pts/0 ; PWD=/home/user ; USER=root ; COMMAND=/bin/bash`;
    this.sendSyslogMessage(message);
  }

  /**
   * Simulate device restart (SNMP trap equivalent via syslog)
   */
  simulateDeviceRestart() {
    console.log('\n=== Simulating Device Restart ===');
    const message = `<30>Jan 1 00:01:00 router kernel: [1234.567890] System reboot: Cold start`;
    this.sendSyslogMessage(message);
  }

  /**
   * Simulate traffic spike
   */
  simulateTrafficSpike() {
    console.log('\n=== Simulating Traffic Spike ===');
    const sourceIps = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'];
    
    for (let i = 0; i < 20; i++) {
      setTimeout(() => {
        const sourceIp = sourceIps[i % sourceIps.length];
        const message = `<30>Jan 1 00:01:1${i} router kernel: [1234.567890] TCP connection from ${sourceIp} to 192.168.1.1:80 bytes=${Math.floor(Math.random() * 10000)}`;
        this.sendSyslogMessage(message);
      }, i * 100);
    }
  }

  /**
   * Run full simulation suite
   */
  async runFullSimulation() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  Security & Intrusion Detection Agent - Simulation       ║');
    console.log('║  Sending simulated security events to agent...          ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    // Sequence of events
    this.simulateFailedLogins(6);  // Triggers brute force alert
    await this.sleep(3500);
    
    this.simulateSuccessfulLogin();
    await this.sleep(1000);
    
    this.simulateAccountLockout();
    await this.sleep(1000);
    
    this.simulateUnauthorizedAccess();
    await this.sleep(1000);
    
    this.simulateAclViolation();
    await this.sleep(1000);
    
    this.simulatePortScan();
    await this.sleep(3000);
    
    this.simulatePrivilegeEscalation();
    await this.sleep(1000);
    
    this.simulateDeviceRestart();
    await this.sleep(1000);
    
    this.simulateTrafficSpike();
    await this.sleep(3000);

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  Simulation Complete!                                    ║');
    console.log('║                                                            ║');
    console.log('║  Check the following for results:                        ║');
    console.log('║  1. Agent logs: docker-compose logs -f security-agent   ║');
    console.log('║  2. Prometheus: http://localhost:9090                    ║');
    console.log('║  3. Grafana: http://localhost:3000                        ║');
    console.log('║                                                            ║');
    console.log('║  You should see:                                          ║');
    console.log('║  - Brute force attack alert (6 failed logins)            ║');
    console.log('║  - Account lockout alert                                  ║');
    console.log('║  - Unauthorized access alert                              ║');
    console.log('║  - ACL violation alert                                    ║');
    console.log('║  - Port scan alert                                        ║');
    console.log('║  - Privilege escalation alert                             ║');
    console.log('║  - Device restart alert                                   ║');
    console.log('║  - Traffic anomaly alert                                  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
  }

  /**
   * Sleep helper function
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Close syslog client
   */
  close() {
    this.syslogClient.close();
  }
}

// Run simulation if called directly
if (require.main === module) {
  const simulation = new SecuritySimulation();
  
  simulation.runFullSimulation().then(() => {
    setTimeout(() => {
      simulation.close();
      process.exit(0);
    }, 2000);
  }).catch((error) => {
    console.error('Simulation error:', error);
    simulation.close();
    process.exit(1);
  });
}

module.exports = SecuritySimulation;