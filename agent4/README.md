# Router Performance Optimization Agent

A comprehensive Node.js-based agent for monitoring and optimizing router performance in mission-critical environments such as banks and hospitals. This agent actively improves efficiency and user experience by analyzing traffic distribution, tracking latency and jitter, enforcing Quality of Service (QoS) priorities, and recommending or triggering load balancing and resource tuning.

## Features

- **SNMP Monitoring**: Real-time collection of CPU, memory, and interface statistics
- **ICMP Tracking**: Continuous latency, jitter, and packet loss monitoring
- **Syslog Listener**: Real-time event processing and critical issue detection
- **QoS Monitoring**: Detection of QoS policy violations and bandwidth overruns
- **Traffic Balancing**: Analysis of traffic distribution across interfaces
- **Optimization Engine**: Intelligent detection and automatic application of performance optimizations
- **Prometheus Integration**: Comprehensive metrics export for monitoring
- **Grafana Dashboard**: Pre-built visualizations for real-time performance monitoring

## Distinction from Other Agents

This agent is **distinct** from other router agents:

- **Monitoring Agent**: Only observes metrics without taking action
- **Resilience Agent**: Ensures uptime through failover mechanisms
- **Security Agent**: Protects against intrusions and misconfigurations
- **Performance Optimization Agent (This)**: **Actively improves efficiency and user experience** through intelligent optimization

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Router with SNMP enabled
- SNMP community string (read-only access)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd router-performance-optimization-agent
```

2. Configure the agent:
```bash
# Edit router.yml with your router details
nano router.yml
```

Update at minimum:
```yaml
router:
  host: "192.168.1.1"          # Your router IP
  snmp:
    community: "public"         # Your SNMP community string
```

3. Start the monitoring stack:
```bash
docker-compose up -d
```

4. Access the dashboards:
- **Grafana**: http://localhost:3000 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Agent Metrics**: http://localhost:9091/metrics

## Configuration

### Main Configuration (router.yml)

The agent is configured entirely through `router.yml` - **no code modification required**.

Key sections:

#### Router Connection
```yaml
router:
  host: "192.168.1.1"
  snmp:
    community: "public"
    port: 161
    version: "2c"
```

#### Optimization Thresholds
```yaml
optimization:
  enabled: true
  auto_apply: false            # Set to true for automatic optimization
  threshold_cpu: 80            # CPU usage threshold (%)
  threshold_memory: 85         # Memory usage threshold (%)
  threshold_latency: 100       # Latency threshold (ms)
  threshold_jitter: 50         # Jitter threshold (ms)
```

#### QoS Configuration
```yaml
qos:
  enabled: true
  priority_classes:
    - name: "critical"
      priority: 7
      bandwidth_percent: 40
```

#### Traffic Balancing
```yaml
traffic_balancing:
  enabled: true
  algorithm: "round_robin"
  imbalance_threshold: 30      # Trigger rebalancing at 30% imbalance
```

## Metrics

The agent exposes the following Prometheus metrics:

### Resource Metrics
- `router_cpu_usage_percent`: Current CPU usage
- `router_memory_usage_percent`: Current memory usage
- `router_efficiency_score`: Overall efficiency score (0-100)

### Network Metrics
- `router_latency_ms`: Latency to destinations (labeled)
- `router_jitter_ms`: Network jitter (labeled)
- `router_packet_loss_percent`: Packet loss percentage (labeled)

### QoS Metrics
- `router_qos_violations`: Number of QoS violations (labeled by class)

### Traffic Metrics
- `router_traffic_imbalance_percent`: Traffic imbalance across interfaces

### Optimization Metrics
- `router_optimizations_triggered_total`: Number of optimizations triggered
- `router_optimizations_applied_total`: Number of optimizations applied

## Optimization Types

The agent can detect and apply the following optimizations:

1. **Reduce CPU Load**: Disable unnecessary services, implement route summarization
2. **Reduce Memory Usage**: Clear buffers, reduce BGP table size
3. **Reduce Latency**: Check link utilization, apply QoS prioritization
4. **Reduce Jitter**: Implement traffic shaping, configure queuing
5. **Reduce Packet Loss**: Check link quality, increase buffers
6. **Optimize QoS**: Adjust bandwidth allocations, review policies
7. **Balance Traffic**: Enable ECMP, adjust routing weights

## Usage Examples

### Manual Testing
```bash
# Check agent health
curl http://localhost:9091/health

# View metrics
curl http://localhost:9091/metrics

# View logs
docker-compose logs -f performance-optimization-agent
```

### Traffic Simulation
```bash
# Start iperf3 server
iperf3 -s -p 5001

# Generate traffic
iperf3 -c <destination> -t 300 -P 10
```

### Multiple Routers
Deploy multiple agent instances with different configurations:
```bash
# Create additional config files
cp router.yml router-router2.yml

# Update with different router IP
# Deploy separate instance
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Performance Optimization Agent                 │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ SNMP Monitor │  │ ICMP Tracker │  │Syslog Listener│     │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                 │                 │              │
│         └─────────────────┼─────────────────┘              │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │QoS Monitor  │                          │
│                    └─────────────┘                          │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │Traffic Balancer│                       │
│                    └─────────────┘                          │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │Optimization Engine│                     │
│                    └─────────────┘                          │
│                           │                                 │
│                    ┌──────┴──────┐                          │
│                    │ Prometheus  │                          │
│                    │  Metrics    │                          │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │     Grafana     │
                    │    Dashboard    │
                    └─────────────────┘
```

## Testing

For comprehensive testing instructions, see [test.md](test.md).

Quick test:
```bash
# Start services
docker-compose up -d

# Verify health
curl http://localhost:9091/health

# Check metrics
curl http://localhost:9091/metrics | grep router_

# View in Grafana
# Navigate to http://localhost:3000
# Open "Router Performance Optimization Dashboard"
```

## Troubleshooting

### Cannot connect to router
- Verify router IP in `router.yml`
- Check SNMP community string
- Ensure SNMP is enabled on router
- Verify firewall allows SNMP (UDP 161)

### Metrics not appearing in Grafana
- Check Prometheus targets: http://localhost:9090/targets
- Verify agent metrics endpoint: `curl http://localhost:9091/metrics`
- Check Grafana datasource configuration

### No optimizations triggered
- Verify thresholds are appropriate in `router.yml`
- Ensure optimization is enabled
- Monitor logs for detection messages
- Check if metrics exceed thresholds

## Logs

Agent logs are stored in `logs/agent.log` and include:
- Monitoring cycle status
- Metric collection results
- Optimization detections and applications
- Errors and warnings

View logs:
```bash
# Real-time logs
docker-compose logs -f performance-optimization-agent

# Log file
cat logs/agent.log
```

## Security Considerations

- SNMP community strings are sent in plaintext (use SNMPv3 for production)
- Syslog messages are unencrypted (use TLS for production)
- Metrics endpoint is unsecured (use reverse proxy with auth for production)
- Keep `router.yml` secure as it contains sensitive credentials

## Performance Impact

- Agent CPU usage: <5%
- Agent memory usage: <100MB
- Network overhead: Minimal (<1 Mbps)
- SNMP queries: Every 30 seconds
- ICMP pings: Every 5 seconds (configurable)

## License

MIT

## Support

For issues and questions:
- Check [test.md](test.md) for testing guidance
- Review logs for error messages
- Verify configuration in `router.yml`

## Version

1.0.0