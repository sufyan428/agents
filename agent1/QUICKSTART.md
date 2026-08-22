# Quick Start Guide - Router Monitoring Agent

## 5-Minute Setup

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure a Router

Edit `config/router.yml` and replace the example router with your own:

```yaml
routers:
  - name: "MyRouter"
    ip: "192.168.1.1"      # Change to your router IP
    port: 161
    version: "2c"
    community: "public"     # Change to your SNMP community
    enabled: true
    poll_interval: 30
    metrics:
      uptime: "1.3.6.1.2.1.1.3.0"
      sysDescr: "1.3.6.1.2.1.1.1.0"
      sysName: "1.3.6.1.2.1.1.5.0"
      cpu: "1.3.6.1.4.1.9.2.1.56.0"           # Cisco CPU (replace for other vendors)
      memory_used: "1.3.6.1.4.1.9.2.1.8.0"    # Cisco memory (replace for other vendors)
      memory_total: "1.3.6.1.4.1.9.2.1.7.0"   # Cisco memory (replace for other vendors)
```

### Step 3: Start the Agent
```bash
npm start
```

You should see:
```
Monitoring Agent running on port 3000
Metrics available at http://localhost:3000/metrics
```

### Step 4: Verify It's Working

Open a new terminal and check the metrics:
```bash
curl http://localhost:3000/metrics | grep router
```

You should see metrics like:
```
router_uptime_seconds{router="MyRouter",ip="192.168.1.1"}
router_cpu_utilization_percent{router="MyRouter",ip="192.168.1.1"}
router_memory_utilization_percent{router="MyRouter",ip="192.168.1.1"}
```

### Step 5: Check Health Status
```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2026-01-25T15:30:00.000Z",
  "uptime": 10.5,
  "routersMonitored": 1
}
```

## Testing Without a Real Router

The agent works fine without actual routers for testing:

1. Start the agent: `npm start`
2. It will log timeout errors (expected)
3. The agent continues running
4. Check `/health` endpoint to confirm it's running

## Adding More Routers

Simply add more routers to `config/router.yml`:

```yaml
routers:
  - name: "Router-Primary"
    ip: "192.168.1.1"
    community: "public"
    enabled: true
    # ... other config
    
  - name: "Router-Secondary"
    ip: "192.168.1.2"
    community: "public"
    enabled: true
    # ... other config
```

## Common Vendor OIDs

### Cisco
```yaml
cpu: "1.3.6.1.4.1.9.2.1.56.0"
memory_used: "1.3.6.1.4.1.9.2.1.8.0"
memory_total: "1.3.6.1.4.1.9.2.1.7.0"
```

### Juniper
```yaml
cpu: "1.3.6.1.4.1.2636.3.1.13.1.8.9.1.0.0"
memory_used: "1.3.6.1.4.1.2636.3.1.13.1.11.9.1.0.0"
```

### Huawei
```yaml
cpu: "1.3.6.1.4.1.2011.5.25.31.1.1.1.1.5.1234"
memory_used: "1.3.6.1.4.1.2011.5.25.31.1.1.1.1.2.1234"
```

## Troubleshooting

### Agent won't start
```bash
# Check Node.js version
node --version  # Must be >= 18

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

### SNMP timeouts
```bash
# Test SNMP connectivity manually
snmpget -v2c -c public 192.168.1.1 1.3.6.1.2.1.1.3.0

# Check if router is reachable
ping 192.168.1.1
```

### No metrics showing
1. Wait 30 seconds for first polling cycle
2. Check logs for errors
3. Verify router is enabled in config (`enabled: true`)
4. Test SNMP connectivity manually

## Next Steps

- Read the full [SETUP_GUIDE.md](SETUP_GUIDE.md) for detailed configuration
- Integrate with Prometheus for monitoring and alerting
- Customize OIDs for your specific network equipment
- Set up alerting rules for critical metrics

## Need Help?

Check the agent logs for detailed error messages. The agent provides comprehensive logging for:
- SNMP queries and responses
- OID conversions and validations
- Error handling and graceful degradation
- Metric collection status