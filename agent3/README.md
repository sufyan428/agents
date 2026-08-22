# Security & Intrusion Detection Agent

A comprehensive security monitoring agent designed to protect mission-critical router environments such as banks and hospitals. The agent actively detects unauthorized access attempts, suspicious traffic patterns, and configuration tampering in real-time.

## Features

### Core Capabilities
- **Authentication Monitoring**: Detects brute force attacks, failed login attempts, and account lockouts
- **Traffic Analysis**: Identifies anomalies, DDoS patterns, port scanning, and unusual protocol usage
- **Configuration Validation**: Compares router configurations against golden baseline to detect tampering
- **Multi-Protocol Support**: Syslog, SNMP traps, ICMP monitoring, optional NETCONF/RESTCONF
- **Real-Time Alerting**: Console, log file, and webhook alert dispatch
- **Metrics & Visualization**: Prometheus metrics integration with Grafana dashboards

### Security Detection
- Unauthorized access attempts
- Brute force attacks
- Configuration drift and tampering
- Traffic spikes and anomalies
- DDoS attack patterns
- Port scanning activity
- ACL violations
- Privilege escalation attempts
- Router unreachability
- High network latency

## Architecture

```
security-id-agent/
├── src/
│   ├── index.js                    # Main entry point
│   ├── config/
│   │   └── config-loader.js        # Configuration management
│   ├── modules/
│   │   ├── authentication-monitor.js
│   │   ├── traffic-analyzer.js
│   │   ├── configuration-validator.js
│   │   └── alert-dispatcher.js
│   ├── protocols/
│   │   ├── syslog-server.js
│   │   ├── snmp-trap-listener.js
│   │   └── icmp-monitor.js
│   └── utils/
│       ├── logger.js
│       └── prometheus-metrics.js
├── config/
│   ├── router.yml                  # Router configuration
│   └── golden-baseline.json        # Golden configuration baseline
├── docker/
│   ├── prometheus/
│   │   ├── prometheus.yml
│   │   └── alerts.yml
│   └── grafana/
│       ├── dashboards/
│       └── provisioning/
├── tests/
│   └── local-simulation.js         # Testing simulation script
├── Dockerfile
├── docker-compose.yml
├── test.md                         # Comprehensive testing guide
└── README.md
```

## Quick Start

### Prerequisites
- Docker and Docker Compose
- Router with syslog and SNMP capabilities
- Network connectivity to router

### 1. Configuration

Edit `config/router.yml` to match your router:

```yaml
router:
  host: "192.168.1.1"  # Your router's IP
  snmp:
    community: "public"  # Your SNMP community string
```

**That's it! No code changes required.**

### 2. Start the Agent

```bash
# Using Docker Compose (recommended)
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f security-agent
```

### 3. Access Dashboards

- **Grafana Dashboard**: http://localhost:3000
  - Username: `admin`
  - Password: `admin`
- **Prometheus**: http://localhost:9090
- **Agent Health**: http://localhost:9091/health
- **Agent Metrics**: http://localhost:9091/metrics

## Configuration

### Router Configuration

The agent is designed to work with your existing routers by simply updating `config/router.yml`:

```yaml
router:
  host: "YOUR_ROUTER_IP"          # Router IP address
  port: 161                       # SNMP port
  snmp:
    community: "YOUR_COMMUNITY"    # SNMP community string
    version: "2c"
    timeout: 5000
```

### Security Thresholds

Adjust detection thresholds based on your environment:

```yaml
security:
  authentication:
    max_failed_attempts: 5        # Alert after 5 failed logins
    time_window_seconds: 300      # Count failures within 5 minutes
    lockout_threshold: 10         # Lockout after 10 failures
  
  traffic:
    baseline_samples: 100         # Samples to establish baseline
    anomaly_threshold: 3.0        # Standard deviations threshold
    spike_threshold: 5.0          # Traffic spike multiplier
  
  configuration:
    validation_interval: 300      # Check config every 5 minutes
    critical_changes: ["acl", "security-policy", "firewall", "nat"]
```

### Router Setup

**Configure Syslog Forwarding:**
```bash
# Cisco IOS
logging host <AGENT_IP>
logging trap informational
logging facility local7

# Juniper
set system syslog host <AGENT_IP> any any
```

**Configure SNMP Traps:**
```bash
# Cisco IOS
snmp-server host <AGENT_IP> version 2c <COMMUNITY>
snmp-server enable traps

# Juniper
set snmp trap-group SECURITY_AGENT target-ips <AGENT_IP>
```

## Testing

### Quick Local Test

```bash
# Run local simulation
npm test

# Or run the simulation script manually
node tests/local-simulation.js
```

This simulates:
- Failed login attempts (triggers brute force alert)
- Account lockouts
- Unauthorized access
- ACL violations
- Port scanning
- Traffic spikes

### Comprehensive Testing

See `test.md` for detailed testing procedures including:
- Phase 1: Local simulation testing
- Phase 2: Real router integration
- Phase 3: Controlled intrusion testing
- Phase 4: Verification & acceptance criteria

## Monitoring

### Grafana Dashboard

The agent includes a pre-configured Grafana dashboard displaying:
- Agent status and health
- Authentication events (failed/successful logins)
- Network traffic analysis
- Configuration drift score
- Threat detection statistics
- ICMP response times
- Alert distribution

### Prometheus Metrics

Key metrics exposed:
- `security_agent_up` - Agent status
- `security_agent_failed_login_attempts_total` - Failed login counter
- `security_agent_successful_login_attempts_total` - Successful login counter
- `security_agent_threats_detected_total` - Threat detection counter
- `security_agent_configuration_drift_score` - Configuration drift
- `security_agent_traffic_anomalies_total` - Traffic anomaly counter
- `security_agent_alerts_total` - Total alerts by type and severity

### Log Files

Logs are stored in `./logs/` directory:
- `security-agent-YYYY-MM-DD.log` - General agent logs
- `security-agent-error-YYYY-MM-DD.log` - Error logs
- `security-alerts-YYYY-MM-DD.log` - Security alerts only

## Alerting

### Alert Channels

Configure alert dispatch in `config/router.yml`:

```yaml
alerts:
  channels:
    console: true          # Print to console
    log: true              # Write to log file
    webhook: false         # Send via webhook
  
  webhook:
    url: "https://your-webhook-endpoint.com/alerts"
    method: "POST"
    headers:
      Authorization: "Bearer YOUR_TOKEN"
```

### Alert Severity Levels

- **Critical**: Immediate action required (e.g., DDoS, critical config changes)
- **High**: Urgent attention needed (e.g., brute force, unauthorized access)
- **Medium**: Monitor closely (e.g., configuration drift, traffic anomalies)
- **Low**: Informational (e.g., unusual protocol usage)

### Alert Format

```json
{
  "alert_id": "alert-1234567890-abc123",
  "timestamp": "2024-01-01T00:00:00Z",
  "type": "brute_force_attack",
  "severity": "critical",
  "title": "Brute Force Attack Detected",
  "description": "Detected 6 failed login attempts for user admin from IP 192.168.1.100",
  "details": {
    "source_ip": "192.168.1.100",
    "username": "admin",
    "attempt_count": 6,
    "recommended_action": "Immediately block IP address and notify security team"
  }
}
```

## Deployment

### Docker Compose (Recommended)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Restart services
docker-compose restart
```

### Standalone Docker

```bash
# Build image
docker build -t security-id-agent .

# Run container
docker run -d \
  --name security-agent \
  -p 9091:9091 \
  -p 514:514/udp \
  -p 162:162/udp \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/logs:/app/logs \
  security-id-agent
```

### Production Considerations

1. **Security**
   - Use strong SNMP community strings
   - Enable SNMPv3 if supported
   - Restrict access to agent ports
   - Use HTTPS for RESTCONF
   - Secure webhook endpoints

2. **Reliability**
   - Configure log rotation
   - Set up alert notifications
   - Monitor agent health
   - Backup golden baseline configuration
   - Document incident response procedures

3. **Performance**
   - Adjust monitoring intervals based on network size
   - Tune thresholds to reduce false positives
   - Monitor resource usage
   - Scale horizontally for large deployments

## Troubleshooting

### Common Issues

**Agent not receiving syslog messages:**
```bash
# Check syslog server is listening
docker-compose logs security-agent | grep "Syslog server listening"

# Test manually
echo "test" | nc -u localhost 514
```

**Agent not receiving SNMP traps:**
```bash
# Verify SNMP configuration on router
show snmp | include host

# Test SNMP connection
snmpwalk -v 2c -c <COMMUNITY> <ROUTER_IP> system
```

**High false positive rate:**
```bash
# Adjust thresholds in config/router.yml
# Restart agent
docker-compose restart security-agent
```

**Grafana dashboard not showing data:**
```bash
# Check Prometheus is scraping
curl http://localhost:9090/api/v1/targets

# Verify Grafana datasource
# Navigate to Configuration > Data Sources > Prometheus
```

See `test.md` for comprehensive troubleshooting guide.

## API Endpoints

### Health Check
```bash
GET /health
```
Returns agent health status and module status.

### Agent Information
```bash
GET /info
```
Returns agent version, capabilities, and configuration.

### Prometheus Metrics
```bash
GET /metrics
```
Returns all Prometheus metrics in text format.

## Development

### Project Structure
- **Core Modules**: Authentication, traffic, configuration validation
- **Protocol Handlers**: Syslog, SNMP traps, ICMP
- **Utilities**: Logging, metrics, configuration management
- **Testing**: Simulation scripts and comprehensive test suite

### Adding New Features
1. Create module in `src/modules/`
2. Add Prometheus metrics in `src/utils/prometheus-metrics.js`
3. Update configuration schema in `config/router.yml`
4. Add tests in `tests/`
5. Update documentation

### Running Tests
```bash
# Run local simulation
npm test

# Check code style
npm run lint

# Run with debug logging
NODE_ENV=debug npm start
```

## Support & Contributing

### Getting Help
- Review `test.md` for testing procedures
- Check logs in `./logs/` directory
- Verify Prometheus metrics at `http://localhost:9090`
- Consult Grafana dashboard at `http://localhost:3000`

### Contributing
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Update documentation
6. Submit a pull request

## License

MIT License - See LICENSE file for details

## Acknowledgments

Built by NinjaTech AI as part of the Router Agent Framework.

## Version History

### Version 1.0.0 (2024-01-01)
- Initial release
- Authentication monitoring
- Traffic analysis
- Configuration validation
- Multi-protocol support (Syslog, SNMP, ICMP)
- Prometheus and Grafana integration
- Comprehensive testing suite
- Docker containerization

---

**Protect your mission-critical infrastructure with real-time security monitoring and intrusion detection.**

For detailed testing procedures and acceptance criteria, see [test.md](test.md).