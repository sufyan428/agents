# Resilience & Failover Agent

## Overview

The Resilience & Failover Agent is a sophisticated network monitoring and failover management system designed for mission-critical environments such as banks, hospitals, and data centers. It ensures high availability by automatically detecting router failures and seamlessly switching to backup routers while maintaining configuration synchronization.

## Features

### Core Capabilities
- **Multi-Protocol Monitoring**: SNMP, ICMP (ping), and Syslog support
- **Automatic Failover**: Detects failures and switches to backup router
- **Intelligent Failback**: Automatically returns to primary router when recovered
- **Configuration Synchronization**: Keeps router configs in sync across devices
- **Real-time Metrics**: Prometheus integration for comprehensive monitoring
- **Grafana Dashboards**: Pre-built visualizations for system status
- **NETCONF/RESTCONF Support**: Optional advanced configuration management
- **Event Logging**: Comprehensive audit trail of all failover events

### Monitoring Protocols
- **SNMP v2c/v3**: Router health monitoring and metrics collection
- **ICMP (Ping)**: Basic connectivity and latency monitoring
- **Syslog**: Event reception and analysis from routers
- **NETCONF**: Programmatic configuration management (optional)
- **RESTCONF**: REST-based configuration interface (optional)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Resilience Agent                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Heartbeat    │  │ Failover     │  │ Config       │      │
│  │ Checker      │  │ Manager      │  │ Sync         │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                 │                  │              │
│  ┌──────▼─────────────────▼──────────────────▼──────┐     │
│  │              SNMP & ICMP Monitors                 │     │
│  └──────────────────────────────────────────────────┘     │
│         │                                                 │
│  ┌──────▼──────────────────────────────────────────┐    │
│  │              Prometheus Metrics                  │    │
│  └─────────────────────────────────────────────────┘    │
│         │                                                 │
│  ┌──────▼──────────────────────────────────────────┐    │
│  │              Express Server                      │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
         │                    │                    │
    ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
    │ Primary │         │ Backup  │         │ Grafana │
    │ Router  │         │ Router  │         │ Dashboard│
    └─────────┘         └─────────┘         └─────────┘
```

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Two routers with SNMP enabled
- Network connectivity between agent and routers
- SNMP community string for routers

### Installation

1. **Clone or Copy the Agent Directory**
   ```bash
   cd agent2-resilience-failover
   ```

2. **Configure Router Settings**
   ```bash
   # Copy the example configuration
   cp config/router.yml.example config/router.yml
   
   # Edit the configuration
   nano config/router.yml
   ```
   
   Update at minimum:
   ```yaml
   primary:
     host: "your-primary-router-ip"
     community: "your-snmp-community-string"
   
   backup:
     host: "your-backup-router-ip"
     community: "your-snmp-community-string"
   ```

3. **Start the Agent**
   ```bash
   # Start all services (agent, Prometheus, Grafana)
   docker-compose up -d
   
   # View logs
   docker-compose logs -f resilience-failover-agent
   ```

4. **Access Monitoring**
   - **Agent Health**: http://localhost:9090/health
   - **Prometheus**: http://localhost:9091
   - **Grafana**: http://localhost:3001 (admin/admin)

### Verification

Check agent status:
```bash
curl http://localhost:9090/health
```

Expected response:
```json
{
  "healthy": true,
  "timestamp": "2024-01-15T10:30:00.000Z",
  "uptime": 10.5,
  "heartbeat": {
    "primary": {
      "health": "healthy",
      "missedHeartbeats": 0
    },
    "backup": {
      "health": "healthy",
      "missedHeartbeats": 0
    }
  }
}
```

## Configuration

### Main Configuration File

The `config/router.yml` file contains all agent settings. You only need to modify the router IP addresses and SNMP community strings for your deployment.

### Key Configuration Sections

#### Router Configuration
```yaml
primary:
  host: "192.168.1.1"        # Primary router IP
  community: "public"        # SNMP community string
  timeout: 5000              # Query timeout (ms)
  retries: 3                 # Number of retries

backup:
  host: "192.168.1.2"        # Backup router IP
  community: "public"        # SNMP community string
```

#### Failover Settings
```yaml
failover:
  enabled: true                              # Enable failover
  heartbeat_interval: 5000                   # Check every 5 seconds
  max_missed_heartbeats: 3                   # Failover after 3 misses
  failback_enabled: true                     # Enable auto failback
  failback_delay: 30000                      # Wait 30s before failback
  auto_failback: true                        # Automatically failback
```

#### Configuration Sync
```yaml
sync:
  enabled: true                              # Enable config sync
  sync_interval: 60000                       # Sync every 60 seconds
  sync_on_failover: true                     # Sync on failover
  backup_path: "/app/data/config-backups"    # Backup location
```

#### Monitoring Settings
```yaml
monitoring:
  snmp_oids:
    - "1.3.6.1.2.1.1.3.0"    # System uptime
    - "1.3.6.1.2.1.1.5.0"    # System name
  ping_interval: 10000                     # Ping every 10 seconds
  ping_count: 4                           # Send 4 pings
```

### Environment Variables

You can override configuration using environment variables:

```bash
PRIMARY_HOST=192.168.1.1
PRIMARY_COMMUNITY=private
BACKUP_HOST=192.168.1.2
BACKUP_COMMUNITY=private
LOG_LEVEL=debug
METRICS_PORT=9090
```

## API Endpoints

### Health & Status
- `GET /health` - Agent health status
- `GET /status` - Detailed agent status
- `GET /heartbeat/status` - Heartbeat checker status

### Metrics
- `GET /metrics` - Prometheus metrics

### Failover Control
- `GET /failover/history` - Failover event history
- `POST /failover/manual` - Trigger manual failover
  ```bash
  curl -X POST http://localhost:9090/failover/manual \
    -H "Content-Type: application/json" \
    -d '{"target": "backup"}'
  ```

### Configuration Sync
- `GET /sync/status` - Config sync status
- `POST /sync/trigger` - Trigger manual config sync

### Syslog
- `GET /syslog/stats` - Syslog statistics

### Configuration
- `GET /config` - Current configuration (sanitized)
- `POST /config/reload` - Reload configuration

## Monitoring & Dashboards

### Prometheus Metrics

The agent exposes comprehensive metrics:

**Router Health Metrics:**
- `router_primary_up` - Primary router status (1=up, 0=down)
- `router_backup_up` - Backup router status (1=up, 0=down)
- `router_response_time_seconds` - Router response time
- `router_uptime_seconds` - Router uptime

**Failover Metrics:**
- `failover_events_total` - Total failover events
- `failback_events_total` - Total failback events
- `missed_heartbeats_total` - Missed heartbeat count

**Config Sync Metrics:**
- `config_sync_status` - Sync status (1=synced, 0=out-of-sync)
- `config_sync_errors_total` - Sync error count

**Agent Metrics:**
- `agent_health` - Agent health status
- `heartbeat_success_total` - Successful heartbeat count

### Grafana Dashboard

Access the pre-configured dashboard at:
- URL: http://localhost:3001
- Login: admin / admin
- Dashboard: "Router Failover Monitoring"

The dashboard displays:
- Router health status (color-coded)
- Response times and latency
- Failover event timeline
- Configuration sync status
- Agent health and uptime
- Missed heartbeats

## Deployment

### Docker Compose (Recommended)

```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose down

# View logs
docker-compose logs -f

# Restart specific service
docker-compose restart resilience-failover-agent
```

### Standalone Docker

```bash
# Build image
docker build -t resilience-failover-agent .

# Run container
docker run -d \
  --name resilience-failover-agent \
  --restart unless-stopped \
  -p 9090:9090 \
  -p 514:514/udp \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/data:/app/data \
  resilience-failover-agent
```

### Production Deployment

#### 1. Prepare Configuration
```bash
# Copy configuration
cp config/router.yml.example config/router.yml

# Edit for production
nano config/router.yml

# Set production logging level
# logging:
#   level: "warn"  # Reduce log verbosity
```

#### 2. Deploy with Docker Compose
```bash
# Use production compose file
docker-compose -f docker-compose.yml up -d

# Check service status
docker-compose ps
```

#### 3. Verify Deployment
```bash
# Check health
curl http://localhost:9090/health

# Check metrics
curl http://localhost:9090/metrics | head -20

# Check logs
docker logs resilience-failover-agent --tail 50
```

### Systemd Service (Native Deployment)

For non-Docker deployments:

```bash
# Create service file
sudo nano /etc/systemd/system/resilience-agent.service
```

Service configuration:
```ini
[Unit]
Description=Resilience & Failover Agent
After=network.target

[Service]
Type=simple
User=nobody
WorkingDirectory=/opt/resilience-agent
ExecStart=/usr/bin/node /opt/resilience-agent/src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable resilience-agent
sudo systemctl start resilience-agent
sudo systemctl status resilience-agent
```

## Testing

Refer to `test.md` for comprehensive testing procedures including:

1. **Local Simulation Testing**: Test with SNMP simulators
2. **Real Router Testing**: Deploy to actual routers
3. **Controlled Failover Tests**: Simulate various failure scenarios
4. **Acceptance Criteria**: Verify all requirements are met

Quick test:
```bash
# Check agent health
curl http://localhost:9090/health

# Trigger manual failover
curl -X POST http://localhost:9090/failover/manual \
  -H "Content-Type: application/json" \
  -d '{"target": "backup"}'

# Check status
curl http://localhost:9090/status

# Verify in Grafana
# Open http://localhost:3001
```

## Troubleshooting

### Common Issues

**Agent cannot connect to routers:**
```bash
# Test SNMP connectivity
snmpwalk -v2c -c public <router-ip> system

# Check firewall
sudo iptables -L | grep 161

# Verify network
ping <router-ip>
```

**Failover not triggering:**
```bash
# Check failover settings
curl http://localhost:9090/config | jq '.failover'

# Manually trigger failover
curl -X POST http://localhost:9090/failover/manual \
  -H "Content-Type: application/json" \
  -d '{"target": "backup"}'
```

**Grafana not showing data:**
```bash
# Check Prometheus targets
curl http://localhost:9091/api/v1/targets

# Verify metrics endpoint
curl http://localhost:9090/metrics

# Reload Grafana dashboard
```

### Debug Mode

Enable detailed logging:
```yaml
# config/router.yml
logging:
  level: "debug"

advanced:
  enable_debug: true
```

Restart and view logs:
```bash
docker-compose restart resilience-failover-agent
docker-compose logs -f resilience-failover-agent
```

### Logs

View agent logs:
```bash
# Real-time logs
docker-compose logs -f resilience-failover-agent

# Last 100 lines
docker logs resilience-failover-agent --tail 100

# Error logs only
docker logs resilience-failover-agent 2>&1 | grep ERROR
```

Log files are stored in:
- `logs/resilience-agent-YYYY-MM-DD.log` - Main logs
- `logs/resilience-agent-error-YYYY-MM-DD.log` - Error logs

## Security Considerations

### Network Security
- Use SNMP v3 with authentication and encryption in production
- Restrict SNMP community strings to read-only
- Implement firewall rules to limit access
- Use VPN or dedicated management network

### Configuration Security
- Never commit configuration files with credentials
- Use environment variables for sensitive data
- Set appropriate file permissions
- Rotate SNMP community strings regularly

### Access Control
- Restrict access to Grafana dashboard
- Use strong passwords for Grafana admin
- Implement authentication for API endpoints if needed
- Monitor access logs regularly

## Performance

### Resource Requirements
- **CPU**: < 30% under normal load
- **Memory**: < 500MB
- **Disk**: < 1GB for logs and backups
- **Network**: Minimal overhead

### Optimization Tips
1. Increase heartbeat interval if CPU usage is high
2. Reduce sync interval if network bandwidth is limited
3. Adjust log levels to reduce disk I/O
4. Use log rotation to manage disk space

### Scaling
The agent is designed to monitor a single pair of routers (primary/backup). For monitoring multiple router pairs:
- Deploy separate agent instances
- Use centralized Prometheus for aggregation
- Create Grafana dashboards for each pair

## Maintenance

### Regular Tasks

**Daily:**
- Check agent health status
- Review error logs
- Verify metrics collection

**Weekly:**
- Review Grafana dashboards
- Check config sync status
- Monitor resource usage

**Monthly:**
- Review failover history
- Audit configuration files
- Test failover functionality

**Quarterly:**
- Update agent software
- Review and update documentation
- Perform full system review

### Backups

Backup important files:
```bash
# Configuration
tar -czf config-backup-$(date +%Y%m%d).tar.gz config/

# State
tar -czf state-backup-$(date +%Y%m%d).tar.gz data/

# Logs (if needed)
tar -czf logs-backup-$(date +%Y%m%d).tar.gz logs/
```

## Support & Contributing

### Getting Help
- Review the `test.md` for troubleshooting
- Check logs for error messages
- Verify configuration settings
- Test with SNMP simulators first

### Reporting Issues
When reporting issues, include:
- Agent version
- Configuration file (sanitized)
- Relevant log excerpts
- Steps to reproduce
- Expected vs actual behavior

## License

MIT License - See LICENSE file for details

## Version History

### Version 1.0.0 (2024)
- Initial release
- SNMP and ICMP monitoring
- Automatic failover and failback
- Configuration synchronization
- Prometheus metrics integration
- Grafana dashboards
- Syslog support
- NETCONF/RESTCONF support (optional)

## Acknowledgments

Built for mission-critical network environments requiring 99.99%+ uptime.

---

For detailed testing procedures, please refer to [test.md](test.md).