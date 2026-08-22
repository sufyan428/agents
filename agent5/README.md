# Automation & Governance Agent

**Agent #5** for the Router Framework - Enforces compliance, automates tasks, and provides governance for mission-critical network environments such as banks and hospitals.

## Overview

This agent ensures routers remain compliant, consistent, and self-healing by:
- **Policy Enforcement**: Checking router settings against organizational standards
- **Configuration Management**: Pushing approved configurations automatically
- **Task Automation**: Scheduling backups, firmware checks, and routine maintenance
- **Self-Healing**: Automatically fixing compliance violations
- **Audit Reporting**: Generating comprehensive compliance and governance reports
- **Metrics & Monitoring**: Exposing Prometheus metrics for Grafana visualization

## Distinction from Other Agents

This agent is **unique** and does **not duplicate** functionality of other agents:

| Agent | Purpose |
|-------|---------|
| **Monitoring Agent** | Observes metrics and collects performance data |
| **Resilience Agent** | Ensures uptime through failover mechanisms |
| **Security Agent** | Protects against intrusions and attacks |
| **Performance Agent** | Optimizes efficiency and resource usage |
| **Automation & Governance Agent** | **Enforces compliance, automates tasks, and provides governance** |

## Quick Start

### 1. Configure Your Routers

Edit **router.yml** - this is the ONLY file you need to modify:

```yaml
routers:
  - name: "Primary-Router-01"
    host: "192.168.1.1"          # CHANGE: Your router IP
    snmp_community: "public"     # CHANGE: Your SNMP community
    snmp_version: "2c"
    snmp_port: 161
    location: "DataCenter-Primary"
    type: "cisco"
```

### 2. Start the Agent

Using Docker Compose (recommended):

```bash
docker-compose up -d
```

Or manually:

```bash
npm install
npm start
```

### 3. Access the Services

- **Agent API**: http://localhost:9091
- **Health Check**: http://localhost:9091/health
- **Prometheus Metrics**: http://localhost:9091/metrics
- **Grafana Dashboard**: http://localhost:3000 (admin/admin)

## Features

### Policy Checking

Automatically checks router configurations against organizational policies:

```bash
curl -X POST http://localhost:9091/api/compliance/check
```

### Self-Healing

Automatically fixes common violations:
- Interface down → Brings interface UP
- Syslog disabled → Enables syslog
- Weak SNMP community → Updates to secure value
- NTP not synced → Resyncs time servers

### Configuration Management

```bash
# Backup configuration
curl -X POST http://localhost:9091/api/config/backup -d '{"router": "Primary-Router-01"}'

# List backups
curl http://localhost:9091/api/config/backups

# Restore configuration
curl -X POST http://localhost:9091/api/config/restore -d '{"router": "Primary-Router-01", "backupFile": "path/to/backup"}'
```

### Automated Tasks

The agent schedules these tasks automatically:
- Policy compliance checks (every 5 minutes)
- Configuration backups (daily at 2 AM)
- Firmware version checks (weekly on Sunday)
- Audit report generation (weekly on Sunday)
- Configuration compliance checks (every 10 minutes)

### Reporting

Generate comprehensive reports:

```bash
# Compliance report
curl -X POST http://localhost:9091/api/reports/generate -d '{"reportType": "compliance"}'

# Audit report
curl -X POST http://localhost:9091/api/reports/generate -d '{"reportType": "audit"}'

# Configuration report
curl -X POST http://localhost:9091/api/reports/generate -d '{"reportType": "configuration"}'

# Self-healing report
curl -X POST http://localhost:9091/api/reports/generate -d '{"reportType": "self_healing"}'
```

## API Endpoints

### Health & Status
- `GET /health` - Health check
- `GET /api/status` - Agent status and overview
- `GET /api/routers` - List configured routers
- `GET /api/policies` - List loaded policies

### Compliance & Governance
- `POST /api/compliance/check` - Run compliance check
- `POST /api/healing/trigger` - Trigger self-healing
- `POST /api/reports/generate` - Generate reports

### Configuration Management
- `POST /api/config/backup` - Backup configuration
- `GET /api/config/backups` - List backups
- `POST /api/config/restore` - Restore configuration

### Task Management
- `POST /api/tasks/execute` - Execute manual task
- `GET /api/tasks/history` - View task history

### Syslog
- `GET /api/syslog/messages` - View syslog messages
- `GET /api/syslog/statistics` - View syslog statistics

### Metrics
- `GET /metrics` - Prometheus metrics (text format)
- `GET /api/metrics/json` - Metrics (JSON format)

## Prometheus Metrics

The agent exposes comprehensive metrics:

- `automation_governance_policies_checked_total` - Policies checked
- `automation_governance_violations_detected_total` - Violations found
- `automation_governance_violations_fixed_total` - Violations fixed
- `automation_governance_configs_backed_up_total` - Configurations backed up
- `automation_governance_configs_pushed_total` - Configurations pushed
- `automation_governance_healing_attempts_total` - Self-healing attempts
- `automation_governance_compliance_score` - Compliance score percentage
- `automation_governance_router_connection_status` - Router connection status

## Grafana Dashboard

Import the dashboard from `dashboards/governance-dashboard.json` or access it automatically at:
http://localhost:3000/d/router-governance/router-automation-governance-dashboard

Dashboard includes:
- Compliance score gauges per router
- Violation rate charts
- Configuration push metrics
- Self-healing statistics
- Router connection status
- Task execution status

## Configuration

### Agent Configuration (config.yml)

Main agent settings including:
- Server port and endpoints
- Governance settings (auto-heal, enforce policies)
- Scheduling intervals
- Backup settings
- Logging configuration
- Audit settings

### Router Configuration (router.yml)

Router connection settings:
- Host IP and SNMP community string
- SNMP version and port
- Location and type
- NETCONF/RESTCONF settings (optional)
- Syslog configuration

### Policies (policies/)

JSON files defining organizational policies:
- Interface status checks
- Syslog configuration
- SNMP security
- CPU usage monitoring
- NTP synchronization

## Architecture

```
automation-governance-agent/
├── src/
│   ├── index.js              # Main application
│   ├── modules/
│   │   ├── policyChecker.js  # Policy enforcement
│   │   ├── configManager.js  # Configuration management
│   │   ├── selfHealing.js    # Self-healing logic
│   │   ├── auditReporter.js  # Audit and reporting
│   │   └── taskScheduler.js  # Task automation
│   └── utils/
│       ├── logger.js         # Logging utility
│       ├── snmpClient.js     # SNMP communication
│       ├── syslogListener.js # Syslog collection
│       ├── metrics.js        # Prometheus metrics
│       └── configLoader.js   # Configuration loading
├── policies/                 # Policy definitions
├── dashboards/              # Grafana dashboards
├── configs/                 # Configuration backups
├── logs/                    # Application and audit logs
├── router.yml               # Router configuration (USER MODIFIABLE)
├── config.yml               # Agent configuration
├── Dockerfile               # Container definition
├── docker-compose.yml       # Full stack deployment
└── prometheus.yml           # Prometheus configuration
```

## Supported Protocols

- **SNMP v1/v2c/v3** - Primary protocol for router communication
- **Syslog** - Event and log message collection (UDP/TCP)
- **NETCONF** - Configuration management (optional)
- **RESTCONF** - Configuration management (optional)

## Testing

For detailed testing instructions, see **test.md** which includes:
- Local simulation tests
- Real router testing procedures
- Controlled test scenarios
- Acceptance criteria

## Compliance & Governance

The agent supports regulatory compliance for:
- **HIPAA** (Healthcare)
- **PCI-DSS** (Banking/Financial)
- **SOC 2** (Security & Availability)
- **ISO 27001** (Information Security)
- **NIST** (Cybersecurity Framework)

## Security Considerations

- Use SNMP v3 with authentication and encryption for production
- Secure SNMP community strings (not "public" or "private")
- Enable HTTPS for NETCONF/RESTCONF
- Implement proper firewall rules
- Regular security audits and updates

## Troubleshooting

### Agent won't start
- Check configuration files are valid YAML
- Verify router IP addresses are reachable
- Ensure SNMP community strings are correct

### No metrics in Grafana
- Verify Prometheus is scraping the agent
- Check metrics endpoint: `http://localhost:9091/metrics`
- Review Prometheus configuration

### Self-healing not working
- Check `auto_heal` is enabled in config.yml
- Review policy healing strategies
- Check logs for healing attempt errors

## License

MIT

## Support

For issues and questions, please refer to the main router framework documentation.