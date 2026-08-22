# Router Monitoring Agent - Setup Guide

## Overview

The Router Monitoring Agent is a production-ready SNMP monitoring solution that collects metrics from network routers and exposes them in Prometheus format. This agent is designed to be organization-friendly, allowing easy customization for different network equipment vendors.

## Quick Start

### Prerequisites

- Node.js 18 or higher
- Network access to target routers with SNMP enabled
- SNMP community string (for SNMPv1/v2c)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure your routers in `config/router.yml`:
```yaml
routers:
  - name: "Router-Primary"
    ip: "192.168.1.1"
    port: 161
    version: "2c"
    community: "public"
    enabled: true
    poll_interval: 30
    metrics:
      uptime: "1.3.6.1.2.1.1.3.0"
      sysDescr: "1.3.6.1.2.1.1.1.0"
      sysName: "1.3.6.1.2.1.1.5.0"
      cpu: "1.3.6.1.4.1.9.2.1.56.0"
      memory_used: "1.3.6.1.4.1.9.2.1.8.0"
      memory_total: "1.3.6.1.4.1.9.2.1.7.0"
      # Add more OIDs as needed
```

3. Start the agent:
```bash
npm start
```

4. Access metrics:
- Metrics endpoint: `http://localhost:3000/metrics`
- Health check: `http://localhost:3000/health`
- Status: `http://localhost:3000/status`

## Configuration

### Router Configuration Structure

Each router in `config/router.yml` requires:

- **name**: Unique identifier for the router
- **ip**: Router IP address
- **port**: SNMP port (default: 161)
- **version**: SNMP version ("1" or "2c")
- **community**: SNMP community string
- **enabled**: Enable/disable monitoring (true/false)
- **poll_interval**: Polling interval in seconds
- **metrics**: Map of metric names to OID strings

### Adding Vendor-Specific OIDs

Organizations can easily add vendor-specific OIDs without code changes:

#### Cisco Example
```yaml
metrics:
  cpu: "1.3.6.1.4.1.9.2.1.56.0"
  memory_used: "1.3.6.1.4.1.9.2.1.8.0"
  memory_total: "1.3.6.1.4.1.9.2.1.7.0"
```

#### Juniper Example
```yaml
metrics:
  cpu: "1.3.6.1.4.1.2636.3.1.13.1.8.9.1.0.0"
  memory_used: "1.3.6.1.4.1.2636.3.1.13.1.11.9.1.0.0"
```

#### Huawei Example
```yaml
metrics:
  cpu: "1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5.1234"
  memory_used: "1.3.6.1.4.1.2011.5.25.31.1.1.1.1.2.1234"
```

### Default OIDs

The agent includes default OIDs in `config/router.yml` that are used as fallbacks:
- Standard MIB-II OIDs (uptime, sysDescr, sysName)
- Common interface statistics
- Cisco-specific OIDs (can be overridden)

## Available Metrics

The agent exposes the following Prometheus metrics:

### Router Metrics
- `router_uptime_seconds` - Router uptime in seconds
- `router_cpu_utilization_percent` - CPU utilization percentage
- `router_memory_utilization_percent` - Memory utilization percentage
- `router_interface_errors_total` - Total interface errors
- `router_bandwidth_in_bytes` - Incoming traffic in bytes
- `router_bandwidth_out_bytes` - Outgoing traffic in bytes
- `router_temperature_celsius` - Temperature in Celsius

### Labels
All router metrics include labels:
- `router` - Router name from configuration
- `ip` - Router IP address

Additional labels for specific metrics:
- `interface` - Interface name (for bandwidth and errors)
- `sensor` - Sensor name (for temperature)
- `direction` - Traffic direction (in/out)

## Testing

### Testing with Real Router

1. Ensure SNMP is enabled on your router
2. Test SNMP connectivity:
```bash
snmpget -v2c -c public 192.168.1.1 1.3.6.1.2.1.1.3.0
```

3. Check agent logs for successful queries
4. Verify metrics appear in `/metrics` endpoint

### Testing Without Real Router

The agent will start successfully even if no routers are reachable. It will:
- Log timeout errors (expected behavior)
- Continue monitoring other routers
- Not crash on SNMP failures
- Expose available metrics from successful queries

## Troubleshooting

### Common Issues

#### 1. SNMP Timeout Errors
**Symptom**: `SNMP get failed for Router-X OID Y: Timeout`

**Solutions**:
- Verify router IP is reachable: `ping 192.168.1.1`
- Check SNMP is enabled on router
- Verify SNMP community string is correct
- Check firewall rules allow UDP port 161
- Ensure correct SNMP version (v1 or v2c)

#### 2. No Metrics Appearing
**Symptom**: `/metrics` endpoint shows only default metrics

**Solutions**:
- Check router is enabled in config (`enabled: true`)
- Verify SNMP queries are successful in logs
- Wait for first polling cycle (default 30 seconds)
- Check Prometheus metrics are being set correctly

#### 3. Invalid OID Errors
**Symptom**: `Skipping invalid OID for Router-X: Y`

**Solutions**:
- Verify OID string is valid format (dot-separated numbers)
- Check OID exists on target device
- Test OID manually: `snmpget -v2c -c public router-ip oid`
- Ensure vendor-specific OIDs are correct for device model

#### 4. Agent Won't Start
**Symptom**: Agent fails to start with initialization error

**Solutions**:
- Check Node.js version: `node --version` (must be >= 18)
- Verify dependencies installed: `npm install`
- Check configuration YAML syntax: `yamllint config/router.yml`
- Review error logs for specific issues

## Monitoring Best Practices

### 1. Polling Intervals
- Use longer intervals (60-300 seconds) for production
- Shorter intervals (10-30 seconds) for testing
- Consider router load when setting intervals

### 2. SNMP Versions
- Use SNMPv2c for better security than v1
- Consider SNMPv3 if available (not supported by this agent yet)
- Use read-only community strings

### 3. Metrics Selection
- Monitor only essential metrics to reduce load
- Focus on uptime, CPU, memory, and critical interfaces
- Add custom OIDs for vendor-specific health indicators

### 4. Alerting
- Use Prometheus alerting rules for metric thresholds
- Set up alerts for high CPU/memory usage
- Monitor for interface errors and packet loss
- Alert on router downtime (uptime resets)

## Security Considerations

1. **SNMP Community Strings**: Use strong, read-only community strings
2. **Network Security**: Restrict access to SNMP ports (161/162)
3. **Firewall Rules**: Only allow SNMP traffic from monitoring server
4. **Configuration Security**: Protect router.yml with proper file permissions
5. **HTTPS**: Consider using reverse proxy with TLS for metrics endpoint

## Advanced Configuration

### Custom Polling Intervals per Router
```yaml
routers:
  - name: "Critical-Router"
    ip: "192.168.1.1"
    poll_interval: 10  # More frequent monitoring
  - name: "Backup-Router"
    ip: "192.168.1.2"
    poll_interval: 60  # Less frequent
```

### Disabling Specific Metrics
```yaml
metrics:
  uptime: "1.3.6.1.2.1.1.3.0"
  # Comment out or remove metrics you don't need
```

### Environment Variables
- `PORT`: Override default HTTP port (default: 3000)
- `METRICS_PORT`: Override metrics port (default: 9090)

## Integration with Prometheus

### Prometheus Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'router-monitoring-agent'
    static_configs:
      - targets: ['localhost:3000']
    scrape_interval: 30s
```

### Example Alert Rules

```yaml
groups:
  - name: router_alerts
    rules:
      - alert: HighRouterCPU
        expr: router_cpu_utilization_percent > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High CPU on {{ $labels.router }}"
          
      - alert: RouterDown
        expr: router_uptime_seconds < 300
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Router {{ $labels.router }} may be down"
```

## Support and Contributing

For issues, questions, or contributions:
- Review logs in the agent output
- Check SNMP connectivity manually
- Verify configuration YAML syntax
- Test OIDs with `snmpget` or `snmpwalk`

## License

MIT License - See LICENSE file for details