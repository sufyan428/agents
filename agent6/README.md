# Router Framework Orchestrator (Agent 6)

**Unified Management System for All 5 Router Monitoring Agents**

## Overview

Agent 6 is the **Framework Orchestrator** that provides centralized management, monitoring, and control for all 5 router monitoring agents:

- **Agent 1**: Router Monitoring (SNMP, Syslog, Metrics)
- **Agent 2**: Resilience & Failover (High Availability)
- **Agent 3**: Security & Intrusion Detection
- **Agent 4**: Performance Optimization
- **Agent 5**: Automation & Governance (Compliance)

## Key Features

✅ **Single Configuration File** - Configure all agents from one `router.yml` file  
✅ **Unified Dashboard** - One Grafana dashboard showing all agent metrics  
✅ **Centralized Control** - Start/stop/restart all agents from one API  
✅ **Health Monitoring** - Automatic health checks and agent restart  
✅ **Easy Deployment** - Docker Compose for one-command deployment  
✅ **Production Ready** - Designed for WiFi router organizations  

## Quick Start (3 Steps)

### Step 1: Edit Configuration

Edit `router.yml` and change ONLY these lines:

```yaml
router:
  primary:
    host: "192.168.1.1"              # CHANGE THIS
    snmp_community: "public"          # CHANGE THIS
  
  backup:
    host: "192.168.1.2"              # CHANGE THIS
    snmp_community: "public"          # CHANGE THIS
```

### Step 2: Install Dependencies

```bash
cd agent6
bash scripts/install-all.sh
```

### Step 3: Start All Agents

```bash
docker-compose up -d
```

**That's it!** All 5 agents are now running and monitoring your routers.

## Access Points

After starting, access these services:

- **Unified Grafana Dashboard**: http://localhost:3000 (admin/admin)
- **Unified Prometheus**: http://localhost:9095
- **Orchestrator API**: http://localhost:8080
- **Agent 1 (Monitoring)**: http://localhost:9090
- **Agent 2 (Resilience)**: http://localhost:9091
- **Agent 3 (Security)**: http://localhost:9092
- **Agent 4 (Performance)**: http://localhost:9093
- **Agent 5 (Automation)**: http://localhost:9094

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Agent 6: Framework Orchestrator                │
│                    (Port 8080)                              │
├─────────────────────────────────────────────────────────────┤
│  • Configuration Distribution                               │
│  • Agent Lifecycle Management                               │
│  • Health Monitoring                                        │
│  • Unified API Gateway                                      │
└────────────────────┬────────────────────────────────────────┘
                     │
     ┌───────────────┼───────────────┐
     │               │               │
┌────▼────┐   ┌─────▼─────┐   ┌────▼────┐
│ Agent 1 │   │  Agent 2  │   │ Agent 3 │
│Monitor  │   │Resilience │   │Security │
│  :9090  │   │   :9091   │   │  :9092  │
└─────────┘   └───────────┘   └─────────┘
     │               │               │
┌────▼────┐   ┌─────▼─────┐        │
│ Agent 4 │   │  Agent 5  │        │
│  Perf   │   │Automation │        │
│  :9093  │   │   :9094   │        │
└─────────┘   └───────────┘        │
     │               │              │
     └───────────────┼──────────────┘
                     │
          ┌──────────▼──────────┐
          │ Unified Prometheus  │
          │      :9095          │
          └──────────┬──────────┘
                     │
          ┌──────────▼──────────┐
          │  Unified Grafana    │
          │      :3000          │
          └─────────────────────┘
                     │
                     ▼
              ┌─────────────┐
              │   Routers   │
              │ 192.168.x.x │
              └─────────────┘
```

## API Endpoints

### System Overview
```bash
# Get overall system status
curl http://localhost:8080/api/overview
```

### Agent Management
```bash
# Get all agents status
curl http://localhost:8080/api/agents

# Get specific agent status
curl http://localhost:8080/api/agents/agent1-monitoring

# Start specific agent
curl -X POST http://localhost:8080/api/agents/agent1-monitoring/start

# Stop specific agent
curl -X POST http://localhost:8080/api/agents/agent1-monitoring/stop

# Restart specific agent
curl -X POST http://localhost:8080/api/agents/agent1-monitoring/restart

# Start all agents
curl -X POST http://localhost:8080/api/agents/start-all

# Stop all agents
curl -X POST http://localhost:8080/api/agents/stop-all
```

### Health Checks
```bash
# Check orchestrator health
curl http://localhost:8080/health

# Check all agents health
curl http://localhost:8080/api/health/agents

# Check specific agent health
curl http://localhost:8080/api/health/agents/agent1-monitoring
```

### Configuration
```bash
# Get current configuration (sanitized)
curl http://localhost:8080/api/config

# Reload and distribute configuration
curl -X POST http://localhost:8080/api/config/reload
```

## Configuration Guide

The `router.yml` file is the **master configuration** for all agents. Here's what you need to know:

### Required Changes (WiFi Router Org)

Only change these values:

```yaml
router:
  primary:
    host: "YOUR_PRIMARY_ROUTER_IP"
    snmp_community: "YOUR_SNMP_COMMUNITY"
  
  backup:
    host: "YOUR_BACKUP_ROUTER_IP"
    snmp_community: "YOUR_SNMP_COMMUNITY"
```

### Optional Settings

You can adjust these if needed:

```yaml
agents:
  monitoring:
    enabled: true              # Enable/disable Agent 1
    
  resilience:
    auto_failover: true        # Enable automatic failover
    
  security:
    alert_level: "high"        # Alert sensitivity
    
  performance:
    auto_optimize: false       # Enable automatic optimization
    
  automation:
    auto_heal: true            # Enable self-healing
```

## Docker Deployment

### Start All Services
```bash
docker-compose up -d
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific agent
docker-compose logs -f agent1-monitoring
```

### Stop All Services
```bash
docker-compose down
```

### Restart Specific Service
```bash
docker-compose restart agent1-monitoring
```

## Testing

### Quick Health Check
```bash
# Check orchestrator
curl http://localhost:8080/health

# Check all agents
curl http://localhost:8080/api/health/agents
```

### Verify Metrics Collection
```bash
# Check Prometheus targets
curl http://localhost:9095/api/v1/targets

# Check agent metrics
curl http://localhost:9090/metrics  # Agent 1
curl http://localhost:9091/metrics  # Agent 2
curl http://localhost:9092/metrics  # Agent 3
curl http://localhost:9093/metrics  # Agent 4
curl http://localhost:9094/metrics  # Agent 5
```

### Verify Grafana
1. Open http://localhost:3000
2. Login: admin/admin
3. Navigate to Dashboards
4. Open "Router Framework Dashboard"
5. Verify all panels show data

## Troubleshooting

### Agents Not Starting

```bash
# Check Docker containers
docker-compose ps

# Check specific agent logs
docker-compose logs agent1-monitoring

# Restart specific agent
docker-compose restart agent1-monitoring
```

### No Metrics in Grafana

```bash
# Check Prometheus targets
curl http://localhost:9095/api/v1/targets

# Verify Prometheus is scraping
docker-compose logs prometheus

# Check Grafana datasource
# Go to Configuration > Data Sources > Prometheus
```

### Configuration Issues

```bash
# Validate router.yml syntax
cat router.yml | python3 -c "import yaml, sys; yaml.safe_load(sys.stdin)"

# Reload configuration
curl -X POST http://localhost:8080/api/config/reload
```

### Router Connection Issues

```bash
# Test SNMP connectivity
snmpwalk -v2c -c YOUR_COMMUNITY YOUR_ROUTER_IP system

# Test ping
ping YOUR_ROUTER_IP

# Check firewall
sudo iptables -L | grep 161
```

## Production Deployment

### Security Recommendations

1. **Change Default Passwords**
   ```yaml
   grafana:
     admin_password: "STRONG_PASSWORD"  # Change this!
   ```

2. **Use SNMPv3**
   ```yaml
   router:
     primary:
       snmp_version: "3"
       snmp_user: "admin"
       snmp_auth: "authPassword"
       snmp_priv: "privPassword"
   ```

3. **Enable HTTPS**
   - Use reverse proxy (nginx/traefik)
   - Add SSL certificates
   - Restrict access to management ports

4. **Network Security**
   - Use dedicated management VLAN
   - Implement firewall rules
   - Enable VPN for remote access

### Monitoring Recommendations

1. **Set Up Alerts**
   - Configure Prometheus alerting rules
   - Set up email/Slack notifications
   - Monitor agent health

2. **Regular Backups**
   ```bash
   # Backup configurations
   tar -czf backup-$(date +%Y%m%d).tar.gz router.yml
   
   # Backup Grafana dashboards
   docker exec unified-grafana grafana-cli admin export-dashboard
   ```

3. **Log Rotation**
   - Configure log rotation for all agents
   - Archive old logs
   - Monitor disk space

## For WiFi Router Organizations

### What You Get

✅ Complete monitoring solution for your router infrastructure  
✅ Automatic failover for high availability  
✅ Security monitoring and intrusion detection  
✅ Performance optimization recommendations  
✅ Compliance and governance automation  
✅ Unified dashboard for all metrics  

### Deployment Steps

1. **Receive the Package**
   - Extract to your server
   - Ensure Docker is installed

2. **Configure Your Routers**
   - Edit `agent6/router.yml`
   - Change IP addresses (lines 7 and 16)
   - Change SNMP community strings (lines 8 and 17)

3. **Deploy**
   ```bash
   cd agent6
   bash scripts/install-all.sh
   docker-compose up -d
   ```

4. **Verify**
   - Open http://YOUR_SERVER:3000
   - Login with admin/admin
   - View the unified dashboard

5. **Done!**
   - All 5 agents are monitoring your routers
   - Automatic failover is active
   - Security monitoring is running
   - Performance optimization is enabled
   - Compliance checks are automated

## Support

### Logs Location
- Orchestrator: `logs/orchestrator.log`
- Agent 1: `../agent1/logs/`
- Agent 2: `../agent2/logs/`
- Agent 3: `../agent3/logs/`
- Agent 4: `../agent4/logs/`
- Agent 5: `../agent5/logs/`

### Common Commands
```bash
# View all logs
docker-compose logs -f

# Check system status
curl http://localhost:8080/api/overview

# Restart everything
docker-compose restart

# Stop everything
docker-compose down

# Start everything
docker-compose up -d
```

## Version

**Version**: 1.0.0  
**Author**: NinjaTech AI  
**License**: MIT

## What Makes This Special

🎯 **Single Configuration** - One file to rule them all  
🎯 **Plug & Play** - Just change IP addresses and go  
🎯 **Production Ready** - Built for mission-critical environments  
🎯 **Easy to Sell** - WiFi router orgs can deploy in minutes  
🎯 **Complete Solution** - Monitoring + Failover + Security + Performance + Governance  

---

**Ready to deploy? Edit `router.yml` and run `docker-compose up -d`!**
