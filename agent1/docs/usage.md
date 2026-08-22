# Router Monitoring Agent - Usage Guide

## Table of Contents

1. [Installation](#installation)
2. [Configuration](#configuration)
3. [Running the Agent](#running-the-agent)
4. [Monitoring and Alerts](#monitoring-and-alerts)
5. [API Reference](#api-reference)
6. [Grafana Integration](#grafana-integration)
7. [Troubleshooting](#troubleshooting)

## Installation

### Prerequisites

- Node.js 18.0.0 or higher
- npm or yarn package manager
- (Optional) Docker for containerized deployment
- (Optional) Prometheus and Grafana for monitoring

### Install Dependencies

```bash
# Navigate to the project directory
cd monitoring-agent

# Install dependencies
npm install
```

### Verify Installation

```bash
# Run tests to verify installation
npm test
```

## Configuration

### Router Configuration

Edit `config/router.yml` to define the routers you want to monitor:

```yaml
routers:
  - name: "Router-Primary"
    ip: "192.168.1.1"
    snmp_community: "public"
    snmp_version: "2c"
    snmp_port: 161
    poll_interval: 30  # seconds
    enabled: true

  - name: "Router-Secondary"
    ip: "192.168.1.2"
    snmp_community: "public"
    snmp_version: "2c"
    snmp_port: 161
    poll_interval: 30
    enabled: true
```

**Configuration Parameters:**
- `name`: Unique identifier for the router
- `ip`: Router IP address
- `snmp_community`: SNMP community string (usually "public" for read-only)
- `snmp_version`: SNMP version ("2c" or "3")
- `snmp_port`: SNMP port (default: 161)
- `poll_interval`: How often to collect metrics (in seconds)
- `enabled`: Whether to monitor this router

### Threshold Configuration

Edit `config/thresholds.yml` to set alert thresholds:

```yaml
cpu:
  warning: 75      # Warning threshold percentage
  critical: 90     # Critical threshold percentage

memory:
  warning: 80      # Warning threshold percentage
  critical: 90     # Critical threshold percentage

bandwidth:
  warning: 80      # Warning threshold percentage
  critical: 95     # Critical threshold percentage

latency:
  warning: 100     # Warning threshold in milliseconds
  critical: 200    # Critical threshold in milliseconds

packet_loss:
  warning: 2       # Warning threshold percentage
  critical: 5      # Critical threshold percentage

temperature:
  warning: 70      # Warning threshold in Celsius
  critical: 85     # Critical threshold in Celsius

failed_logins:
  warning: 5       # Number of failed login attempts per minute
  critical: 10     # Critical threshold per minute

interface_errors:
  warning: 100     # Number of errors per minute
  critical: 500    # Critical threshold per minute
```

### Environment Variables

Create a `.env` file in the project root:

```bash
# Agent Configuration
PORT=3000                  # HTTP server port
LOG_LEVEL=info             # Log level: debug, info, warn, error

# Email Alerts (optional)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-email@example.com
SMTP_PASS=your-password
SMTP_FROM=monitoring-agent@example.com
ALERT_EMAIL_RECIPIENT=admin@example.com

# API Webhook (optional)
ALERT_API_ENDPOINT=https://your-monitoring-system.com/api/alerts
```

## Running the Agent

### Development Mode

```bash
# Start with auto-reload on file changes
npm run dev
```

### Production Mode

```bash
# Start the agent
npm start
```

### Docker Deployment

```bash
# Build the Docker image
docker build -t router-monitoring-agent .

# Run the container
docker run -d \
  --name monitoring-agent \
  -p 3000:3000 \
  -v $(pwd)/config:/app/config \
  --env-file .env \
  router-monitoring-agent
```

### Verify Agent is Running

```bash
# Check health endpoint
curl http://localhost:3000/health

# Check status endpoint
curl http://localhost:3000/status

# View metrics
curl http://localhost:3000/metrics
```

## Monitoring and Alerts

### Console Alerts

Alerts are displayed in the console with visual formatting:

```
================================================================================
🚨 ALERT [CRITICAL]
⏰ Time: 1/15/2024, 2:30:45 PM
📍 Router: Router-Primary
📊 Metric: cpu
📈 Value: 95 (Threshold: 90)
ℹ️  Details: High CPU load detected: 95% at 02:30 PM
================================================================================
```

### Email Alerts

Configure SMTP settings in `.env` to receive email alerts. Emails include:
- Plain text and HTML versions
- Severity indicators with color coding
- Complete alert details
- Timestamp and router information

### API Webhook Alerts

Configure `ALERT_API_ENDPOINT` to push alerts to external systems:

```bash
# Example payload sent to webhook
{
  "alert": {
    "metric": "cpu",
    "severity": "critical",
    "router": "Router-Primary",
    "value": 95,
    "threshold": 90,
    "timestamp": "2024-01-15T14:30:45Z",
    "message": "CPU CRITICAL on Router-Primary: 95%"
  },
  "timestamp": "2024-01-15T14:30:45Z",
  "source": "router-monitoring-agent"
}
```

### Alert History

View recent alerts via API:

```bash
# Get last 100 alerts
curl http://localhost:3000/alerts

# Get last 50 alerts
curl http://localhost:3000/alerts?limit=50
```

## API Reference

### GET `/health`

Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T14:30:45Z",
  "uptime": 3600,
  "routersMonitored": 2
}
```

### GET `/status`

Get agent status and statistics.

**Response:**
```json
{
  "status": "running",
  "timestamp": "2024-01-15T14:30:45Z",
  "uptime": 3600,
  "collectors": {
    "snmp": "active",
    "netflow": "active",
    "syslog": "active"
  },
  "alertStats": {
    "total": 15,
    "bySeverity": {
      "warning": 10,
      "critical": 5
    },
    "byMetric": {
      "cpu": 8,
      "memory": 4,
      "temperature": 3
    },
    "byRouter": {
      "Router-Primary": 10,
      "Router-Secondary": 5
    }
  },
  "thresholds": {
    "cpu": { "warning": 75, "critical": 90 },
    "memory": { "warning": 80, "critical": 90 }
  }
}
```

### GET `/alerts`

Get alert history.

**Query Parameters:**
- `limit` (optional): Number of alerts to return (default: 100)

**Response:**
```json
[
  {
    "metric": "cpu",
    "severity": "critical",
    "router": "Router-Primary",
    "value": 95,
    "threshold": 90,
    "timestamp": "2024-01-15T14:30:45Z",
    "message": "CPU CRITICAL on Router-Primary: 95%",
    "sentAt": "2024-01-15T14:30:45Z"
  }
]
```

### POST `/test`

Send a test alert to verify alert configuration.

**Response:**
```json
{
  "message": "Test alert sent",
  "alert": {
    "metric": "test",
    "severity": "warning",
    "router": "TestRouter",
    "value": 85,
    "threshold": 80,
    "timestamp": "2024-01-15T14:30:45Z",
    "message": "Test alert sent manually",
    "details": "This is a test alert for monitoring purposes"
  }
}
```

### GET `/metrics`

Prometheus metrics endpoint (scraped by Prometheus).

**Response:** Text format with Prometheus metrics

## Grafana Integration

### 1. Install Prometheus

Download and configure Prometheus to scrape the agent:

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'router-monitoring-agent'
    static_configs:
      - targets: ['localhost:3000']
```

### 2. Install Grafana

Install Grafana and connect to Prometheus:

1. Add Prometheus as a data source
2. Import or create dashboards

### 3. Create Grafana Dashboard

**Example Dashboard Panels:**

#### CPU Utilization
- Query: `rate(router_cpu_utilization_percent[5m])`
- Type: Gauge
- Unit: Percent (0-100)
- Thresholds: Warning (75%), Critical (90%)

#### Memory Utilization
- Query: `router_memory_utilization_percent`
- Type: Gauge
- Unit: Percent (0-100)
- Thresholds: Warning (80%), Critical (90%)

#### Temperature
- Query: `router_temperature_celsius`
- Type: Gauge
- Unit: Celsius
- Thresholds: Warning (70°C), Critical (85°C)

#### Bandwidth In/Out
- Query: `rate(router_bandwidth_in_bytes[5m])`
- Type: Graph
- Unit: bytes/sec
- Legend: {{router}} - {{interface}}

#### Alerts Triggered
- Query: `rate(monitoring_alerts_triggered_total[1h])`
- Type: Graph
- Legend: {{router}} - {{severity}} - {{metric}}

### 4. Alert Rules in Prometheus

Create alert rules in Prometheus:

```yaml
# alerts.yml
groups:
  - name: router_alerts
    rules:
      - alert: HighCPUUsage
        expr: router_cpu_utilization_percent > 90
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High CPU usage on {{ $labels.router }}"
          description: "CPU usage is {{ $value }}%"

      - alert: HighMemoryUsage
        expr: router_memory_utilization_percent > 90
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High memory usage on {{ $labels.router }}"
          description: "Memory usage is {{ $value }}%"
```

## Troubleshooting

### Agent Won't Start

**Problem:** Agent fails to start with configuration errors

**Solution:**
1. Check YAML syntax in configuration files
2. Verify router IP addresses are reachable
3. Check SNMP community strings are correct
4. Review logs in `logs/combined.log`

```bash
# Check logs
tail -f logs/combined.log
```

### SNMP Queries Failing

**Problem:** SNMP collector shows connection errors

**Solution:**
1. Verify SNMP is enabled on the router
2. Check firewall rules allow SNMP (UDP 161)
3. Test SNMP connectivity:

```bash
# Test SNMP query
snmpwalk -v2c -c public 192.168.1.1 1.3.6.1.2.1.1.3.0
```

4. Verify SNMP community string matches router configuration

### No Metrics in Prometheus

**Problem:** Prometheus shows no metrics from agent

**Solution:**
1. Verify metrics endpoint is accessible:
```bash
curl http://localhost:3000/metrics
```

2. Check Prometheus configuration:
```yaml
scrape_configs:
  - job_name: 'router-monitoring-agent'
    static_configs:
      - targets: ['localhost:3000']
```

3. Check Prometheus logs for scraping errors

### Alerts Not Sending

**Problem:** Alerts triggered but not received

**Solution:**

**Email Alerts:**
1. Verify SMTP credentials in `.env`
2. Check email server connectivity:
```bash
telnet smtp.example.com 587
```
3. Verify recipient email address
4. Check spam folder

**API Alerts:**
1. Verify `ALERT_API_ENDPOINT` is correct
2. Test webhook manually:
```bash
curl -X POST https://your-api.com/alerts \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```
3. Check API server logs

### High Memory Usage

**Problem:** Agent consuming too much memory

**Solution:**
1. Reduce polling intervals in `router.yml`
2. Reduce alert history limit (default: 1000)
3. Reduce flow/event retention time
4. Check for memory leaks in logs

### NetFlow Not Receiving Data

**Problem:** NetFlow collector shows no incoming data

**Solution:**
1. Verify NetFlow is enabled on routers
2. Check firewall allows UDP port 2055
3. Verify router NetFlow configuration
4. Check agent is listening on correct port:

```bash
# Check if port is listening
netstat -an | grep 2055
```

### Syslog Not Receiving Events

**Problem:** Syslog collector shows no events

**Solution:**
1. Verify Syslog is enabled on routers
2. Check firewall allows UDP port 514
3. Test syslog from router
4. Check agent is listening on correct port

## Performance Tuning

### Optimize Polling Intervals

For large router deployments, adjust polling intervals:

```yaml
routers:
  - name: "Router-Primary"
    poll_interval: 60  # Increase from 30 to 60 seconds
```

### Reduce Metric Retention

Limit in-memory data retention:

```javascript
// In netflowCollector.js and syslogCollector.js
this.flows.clearOldFlows(3);  // Clear every 3 minutes instead of 5
```

### Log Rotation

Winston automatically rotates logs at 5MB. Adjust as needed:

```javascript
// In logger.js
maxsize: 10485760,  // 10MB instead of 5MB
maxFiles: 3         // Keep 3 files instead of 5
```

## Best Practices

1. **Start with Warning Thresholds**: Set warning thresholds first, then adjust critical thresholds based on patterns
2. **Test Alerts**: Use `/test` endpoint to verify alert configuration before production
3. **Monitor the Agent**: Use `/status` endpoint to track agent health
4. **Regular Review**: Periodically review and adjust thresholds based on actual usage
5. **Backup Configurations**: Keep version control of configuration files
6. **Use SNMP v3**: For production environments, use SNMP v3 for security
7. **Separate Networks**: Consider running monitoring on a separate network segment
8. **Redundancy**: Deploy multiple agents for critical infrastructure

## Support and Contributing

For issues, questions, or contributions:
- Review logs in `logs/` directory
- Check architecture documentation for design details
- Run tests to verify functionality: `npm test`
- Monitor Prometheus metrics for performance insights