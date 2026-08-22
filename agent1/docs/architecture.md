# Router Monitoring Agent - Architecture Documentation

## Overview

The Router Monitoring Agent is a lightweight, automation-based monitoring solution designed to track router health and traffic metrics. It uses SNMP, NetFlow, and Syslog protocols to collect data and applies simple threshold-based rules to trigger alerts when issues are detected.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Router Monitoring Agent                  │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ SNMP         │  │ NetFlow      │  │ Syslog       │       │
│  │ Collector    │  │ Collector    │  │ Collector    │       │
│  │              │  │              │  │              │       │
│  │ - CPU        │  │ - Traffic    │  │ - Events     │       │
│  │ - Memory     │  │ - Flows      │  │ - Logins     │       │
│  │ - Temp       │  │ - Bandwidth  │  │ - Security   │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │                │
│         └─────────────────┴─────────────────┘                │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Threshold Processor                         │   │
│  │                                                       │   │
│  │  - Apply rules & thresholds                           │   │
│  │  - Compare against limits                             │   │
│  │  - Determine alert severity                           │   │
│  └────────────────────┬──────────────────────────────────┘   │
│                       │                                      │
│                       ▼                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Alert Manager                            │   │
│  │                                                       │   │
│  │  - Console alerts                                     │   │
│  │  - Email notifications                                │   │
│  │  - API webhook push                                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                           │                                  │
│         ┌─────────────────┼─────────────────┐               │
│         ▼                 ▼                 ▼               │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐          │
│  │ Prometheus │   │ Grafana    │   │ Dashboard  │          │
│  │ Metrics    │   │ Dashboard  │   │ API        │          │
│  └────────────┘   └────────────┘   └────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. Collectors Module

The collectors are responsible for gathering data from routers using various protocols.

#### SNMP Collector
- **Protocol**: SNMP v2c/v3
- **Metrics Collected**:
  - CPU utilization
  - Memory usage
  - Temperature readings
  - System uptime
  - Interface statistics (bandwidth, errors)
- **Polling Interval**: Configurable per router (default: 30 seconds)
- **Implementation**: Uses `snmp-native` library for SNMP queries

#### NetFlow Collector
- **Protocol**: NetFlow/IPFIX (UDP)
- **Default Port**: 2055
- **Metrics Collected**:
  - Traffic flows (source/destination IP, ports)
  - Protocol information
  - Bytes and packet counts
  - Flow duration
- **Implementation**: Uses `netflow-parser` for packet parsing

#### Syslog Collector
- **Protocol**: Syslog (UDP)
- **Default Port**: 514
- **Metrics Collected**:
  - System events
  - Failed login attempts
  - Security-related events
  - Authentication failures
- **Implementation**: Custom UDP server with regex pattern matching

### 2. Processors Module

Processors transform raw collected data and apply business logic.

#### Threshold Processor
- **Function**: Compares metrics against configured thresholds
- **Thresholds**:
  - Warning: Lower threshold for early notification
  - Critical: Upper threshold for immediate action
- **Supported Metrics**:
  - CPU > 75% (warning) / 90% (critical)
  - Memory > 80% (warning) / 90% (critical)
  - Bandwidth > 80% (warning) / 95% (critical)
  - Latency > 100ms (warning) / 200ms (critical)
  - Packet loss > 2% (warning) / 5% (critical)
  - Temperature > 70°C (warning) / 85°C (critical)
  - Failed logins > 5/min (warning) / 10/min (critical)
- **Output**: Alert objects with severity levels

### 3. Alerts Module

Manages alert delivery through multiple channels.

#### Alert Manager
- **Channels**:
  - **Console**: Formatted console output with visual indicators
  - **Email**: SMTP-based email notifications with HTML formatting
  - **API**: Webhook push to external monitoring systems
- **Alert History**: Maintains in-memory history of last 1000 alerts
- **Statistics**: Tracks alerts by severity, metric, and router

### 4. Utilities Module

Provides shared functionality across the application.

#### Logger
- **Library**: Winston
- **Features**:
  - Structured logging with timestamps
  - Multiple log levels (debug, info, warn, error)
  - Console and file outputs
  - Log rotation (5MB max, 5 files)
  - Stack trace for errors

#### Configuration Loader
- **Format**: YAML
- **Files**:
  - `router.yml`: Router connection details and SNMP OIDs
  - `thresholds.yml`: Alert threshold definitions
- **Features**: Dynamic reloading, validation, default values

#### Prometheus Exporter
- **Library**: `prom-client`
- **Metrics Exposed**:
  - `router_cpu_utilization_percent`
  - `router_memory_utilization_percent`
  - `router_temperature_celsius`
  - `router_bandwidth_in_bytes`
  - `router_bandwidth_out_bytes`
  - `router_latency_milliseconds`
  - `router_packet_loss_percent`
  - `router_interface_errors_total`
  - `router_failed_logins_total`
  - `router_uptime_seconds`
  - `monitoring_alerts_triggered_total`
- **Endpoint**: `/metrics` (for Prometheus scraping)

## Data Flow

### 1. Collection Phase
```
Router → SNMP Query → SNMP Collector → Raw Metrics
Router → NetFlow UDP → NetFlow Collector → Flow Data
Router → Syslog UDP → Syslog Collector → Event Data
```

### 2. Processing Phase
```
Raw Metrics → Threshold Processor → Comparison → Alert Object
Event Data → Pattern Matching → Failed Login Count → Alert Object
```

### 3. Alerting Phase
```
Alert Object → Alert Manager → Console Output
Alert Object → Alert Manager → Email Notification
Alert Object → Alert Manager → API Webhook
```

### 4. Storage Phase
```
All Metrics → Prometheus Exporter → Prometheus Database
Prometheus → Grafana Dashboard → Visualizations
```

## API Endpoints

### GET `/metrics`
- **Purpose**: Expose Prometheus metrics
- **Content-Type**: `text/plain`
- **Usage**: Scraped by Prometheus for time-series data

### GET `/health`
- **Purpose**: Health check endpoint
- **Response**:
  ```json
  {
    "status": "healthy",
    "timestamp": "2024-01-15T10:30:00Z",
    "uptime": 3600,
    "routersMonitored": 2
  }
  ```

### GET `/status`
- **Purpose**: Get agent status and statistics
- **Response**: Full status including collectors, alerts, and thresholds

### GET `/alerts`
- **Purpose**: Get alert history
- **Query Params**: `limit` (default: 100)
- **Response**: Array of recent alerts

### POST `/test`
- **Purpose**: Send test alert for verification
- **Response**: Confirmation with alert details

## Configuration Structure

### Router Configuration (`router.yml`)
```yaml
routers:
  - name: "Router-Primary"
    ip: "192.168.1.1"
    snmp_community: "public"
    snmp_version: "2c"
    poll_interval: 30
    enabled: true
```

### Threshold Configuration (`thresholds.yml`)
```yaml
cpu:
  warning: 75
  critical: 90

memory:
  warning: 80
  critical: 90
```

## Scalability Considerations

### Horizontal Scaling
- Each agent can monitor multiple routers
- Multiple agents can be deployed for redundancy
- Stateless design enables easy scaling

### Performance
- Asynchronous SNMP queries to prevent blocking
- Rate limiting for alert notifications
- In-memory data structures for fast lookups
- Configurable polling intervals

### Resource Management
- Automatic cleanup of old flows and events
- Alert history limited to 1000 entries
- Log rotation to prevent disk space issues

## Security Considerations

### SNMP Security
- Supports SNMP v3 for encrypted communication
- Community strings should be kept secure
- Read-only access recommended

### Network Security
- NetFlow and Syslog on UDP (firewall considerations)
- API endpoints can be protected with authentication
- No sensitive data in logs

### Alert Security
- Email credentials in environment variables
- API endpoints with HTTPS in production
- No plaintext passwords in alerts

## Integration Points

### Meta-Agent Controller
The monitoring agent is designed to be integrated into a larger meta-agent controller:

1. **Status Endpoint**: Controller can query `/status` for health
2. **API Endpoints**: Controller can trigger actions via REST API
3. **Metrics**: Prometheus metrics for controller monitoring
4. **Alert Hooks**: API webhook for alert aggregation

### External Systems
- **Prometheus**: Time-series database for metrics storage
- **Grafana**: Visualization and dashboarding
- **Email Servers**: SMTP for alert notifications
- **Monitoring APIs**: Webhook integration for alert forwarding

## Error Handling

### Collection Errors
- SNMP query failures logged and retried
- Network errors handled gracefully
- Individual router failures don't affect others

### Processing Errors
- Invalid data logged and skipped
- Threshold checks continue on other metrics
- Alert failures don't stop collection

### Alert Errors
- Email failures logged but don't retry
- API failures logged with details
- Console alerts always succeed

## Monitoring the Agent

The agent itself is monitorable via:
1. **Health Endpoint**: Check if agent is running
2. **Prometheus Metrics**: Monitor agent performance
3. **Logs**: Winston logs for debugging
4. **Alert History**: Track alert patterns

## Future Enhancements

Potential improvements for future versions:
1. Machine learning for anomaly detection
2. Predictive alerting based on trends
3. Support for additional protocols (sFlow, IPFIX v10)
4. Web-based configuration UI
5. Multi-region support
6. Advanced alert aggregation
7. Historical data analysis
8. Automated remediation actions