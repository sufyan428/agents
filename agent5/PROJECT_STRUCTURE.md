# Automation & Governance Agent - Project Structure

Complete file and directory structure of the agent.

```
automation-governance-agent/
├── src/
│   ├── index.js                          # Main application entry point
│   │
│   ├── modules/                          # Core functionality modules
│   │   ├── policyChecker.js              # Policy enforcement and compliance checking
│   │   ├── configManager.js              # Configuration backup, push, and restore
│   │   ├── selfHealing.js                # Automatic violation remediation
│   │   ├── auditReporter.js              # Audit logging and report generation
│   │   └── taskScheduler.js              # Automated task scheduling
│   │
│   └── utils/                            # Utility modules
│       ├── logger.js                     # Winston-based logging
│       ├── snmpClient.js                 # SNMP communication (v1/v2c/v3)
│       ├── syslogListener.js             # Syslog message collection
│       ├── metrics.js                    # Prometheus metrics exposure
│       └── configLoader.js               # Configuration file loading
│
├── policies/                             # Policy definitions (JSON)
│   ├── interface_status.json             # Interface UP check
│   ├── syslog_enabled.json               # Syslog enabled check
│   ├── snmp_security.json                # SNMP community security
│   ├── cpu_usage.json                    # CPU usage monitoring
│   └── ntp_sync.json                     # NTP synchronization check
│
├── dashboards/                           # Grafana dashboards
│   └── governance-dashboard.json         # Main governance dashboard
│
├── configs/                              # Configuration storage (created at runtime)
│   └── backups/                          # Router configuration backups
│
├── logs/                                 # Log files (created at runtime)
│   ├── combined.log                      # All logs
│   ├── error.log                         # Error logs only
│   └── audit/                            # Audit event logs
│       ├── audit_<date>.log              # Daily audit logs
│       ├── compliance_report_<timestamp>.json
│       ├── audit_report_<timestamp>.json
│       ├── configuration_report_<timestamp>.json
│       └── self_healing_report_<timestamp>.json
│
├── router.yml                            # Router configuration (USER MODIFIABLE)
├── config.yml                            # Agent configuration
├── prometheus.yml                        # Prometheus scraping configuration
├── grafana-datasources.yml               # Grafana Prometheus datasource
├── docker-compose.yml                    # Full stack deployment
├── Dockerfile                            # Container definition
├── package.json                          # Node.js dependencies
├── .gitignore                            # Git ignore rules
├── README.md                             # Full documentation
├── QUICKSTART.md                         # Quick start guide
├── test.md                               # Comprehensive testing guide
└── PROJECT_STRUCTURE.md                  # This file
```

## Key Components

### Main Application (src/index.js)
- Express.js HTTP server
- REST API endpoints
- Module orchestration
- Graceful shutdown

### Modules

#### PolicyChecker
- Loads and validates policies
- Checks router compliance
- Detects violations
- Generates recommendations

#### ConfigManager
- Backs up router configurations
- Pushes configuration changes
- Restores from backups
- Manages backup retention

#### SelfHealing
- Analyzes violations
- Applies healing strategies
- Retries failed attempts
- Verifies fixes

#### AuditReporter
- Logs all operations
- Generates compliance reports
- Creates audit trails
- Produces governance reports

#### TaskScheduler
- Schedules automated tasks
- Executes cron jobs
- Maintains task history
- Supports manual execution

### Utilities

#### Logger
- Multi-level logging
- File and console output
- Log rotation
- Error tracking

#### SNMPClient
- SNMP v1/v2c/v3 support
- GET, SET, WALK operations
- Connection pooling
- Error handling

#### SyslogListener
- UDP/TCP syslog server
- RFC 3164 and RFC 5424 parsing
- Message filtering
- Statistics tracking

#### Metrics
- Prometheus metrics
- Custom governance metrics
- HTTP exposure
- Label-based organization

#### ConfigLoader
- YAML configuration loading
- Validation
- Error handling
- Configuration access

### Configuration Files

#### router.yml
- Router connection details
- SNMP settings
- NETCONF/RESTCONF (optional)
- Syslog configuration

#### config.yml
- Agent settings
- Governance options
- Scheduling intervals
- Backup and audit settings

### Policies

Each policy includes:
- Name and description
- Type (snmp_oid, configuration, syslog_pattern)
- Severity level
- Expected values
- Healing strategy (optional)
- Compliance requirements

### Docker Services

#### automation-governance-agent
- Main application
- Exposes port 9091
- Mounts configuration and logs
- Health check enabled

#### prometheus
- Metrics collection
- Scrape interval: 15s
- Data persistence
- Web UI on port 9090

#### grafana
- Data visualization
- Dashboard provisioning
- Datasource configuration
- Web UI on port 3000

## API Endpoints

### Health & Status
- `GET /health` - Health check
- `GET /api/status` - Agent status
- `GET /api/routers` - List routers
- `GET /api/policies` - List policies

### Compliance
- `POST /api/compliance/check` - Run compliance check
- `POST /api/healing/trigger` - Trigger self-healing

### Configuration
- `POST /api/config/backup` - Backup configuration
- `GET /api/config/backups` - List backups
- `POST /api/config/restore` - Restore configuration

### Tasks
- `POST /api/tasks/execute` - Execute task manually
- `GET /api/tasks/history` - Task history

### Reports
- `POST /api/reports/generate` - Generate reports
  - Types: compliance, audit, configuration, self_healing

### Syslog
- `GET /api/syslog/messages` - View messages
- `GET /api/syslog/statistics` - View statistics

### Metrics
- `GET /metrics` - Prometheus metrics (text)
- `GET /api/metrics/json` - Metrics (JSON)

## Scheduled Tasks

Default schedules:
- Policy check: Every 5 minutes
- Config backup: Daily at 2 AM
- Firmware check: Weekly Sunday at 3 AM
- Audit report: Weekly Sunday at 6 AM
- Config compliance: Every 10 minutes

## Prometheus Metrics

Key metrics exposed:
- `automation_governance_policies_checked_total`
- `automation_governance_violations_detected_total`
- `automation_governance_violations_fixed_total`
- `automation_governance_configs_backed_up_total`
- `automation_governance_configs_pushed_total`
- `automation_governance_healing_attempts_total`
- `automation_governance_compliance_score`
- `automation_governance_router_connection_status`
- And many more...

## Data Flow

1. **Configuration Loading**: Configs loaded from YAML files
2. **Policy Enforcement**: Policies checked against router state via SNMP
3. **Violation Detection**: Non-compliant settings identified
4. **Self-Healing**: Automatic remediation triggered
5. **Audit Logging**: All operations logged
6. **Metrics Exposure**: Metrics sent to Prometheus
7. **Visualization**: Grafana displays metrics and dashboards
8. **Reporting**: Reports generated and stored

## Extensibility

The agent is designed for easy extension:

- **Add Policies**: Create new JSON files in `policies/`
- **Add Healing Strategies**: Extend `selfHealing.js`
- **Add Tasks**: Add to `taskScheduler.js`
- **Add Metrics**: Extend `metrics.js`
- **Add Protocols**: Create new utility modules

## Security Features

- SNMP v3 support with authentication and encryption
- Audit logging for all operations
- Configuration backup before changes
- Approval workflow for changes (optional)
- Secure credential handling

## Compliance Support

Out-of-the-box support for:
- HIPAA (Healthcare)
- PCI-DSS (Banking/Financial)
- SOC 2
- ISO 27001
- NIST Cybersecurity Framework

## Monitoring & Alerting

- Real-time compliance monitoring
- Automated violation detection
- Self-healing notifications
- Scheduled task status
- Router connection health
- Performance metrics

## Deployment Options

1. **Docker Compose** (Recommended): Full stack with monitoring
2. **Docker Only**: Agent container only
3. **Local Development**: Node.js directly
4. **Kubernetes**: Helm charts (optional)

## Production Considerations

- Use SNMP v3 for security
- Implement proper firewall rules
- Regular backup verification
- Log rotation and retention
- High availability setup
- Disaster recovery planning