# Deployment Guide for WiFi Router Organizations

This guide provides step-by-step instructions for deploying the Router Framework Orchestrator in your production environment.

## Prerequisites

- Linux server (Ubuntu 20.04+ recommended)
- Docker and Docker Compose installed
- Network access to your routers
- SNMP enabled on routers
- Minimum 4GB RAM, 2 CPU cores

## Installation Steps

### 1. Prepare the Server

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo apt install docker-compose -y

# Add your user to docker group
sudo usermod -aG docker $USER
newgrp docker
```

### 2. Deploy the Framework

```bash
# Extract the package
cd /opt
tar -xzf router-framework.tar.gz
cd allagents/agent6

# Edit configuration
nano router.yml
```

**Change these lines:**
```yaml
router:
  primary:
    host: "YOUR_PRIMARY_ROUTER_IP"      # Line 7
    snmp_community: "YOUR_COMMUNITY"     # Line 8
  
  backup:
    host: "YOUR_BACKUP_ROUTER_IP"       # Line 16
    snmp_community: "YOUR_COMMUNITY"     # Line 17
```

### 3. Install Dependencies

```bash
# Install all agent dependencies
bash scripts/install-all.sh
```

This will install npm packages for all 5 agents and the orchestrator.

### 4. Start the Framework

```bash
# Start all services
docker-compose up -d

# Verify all containers are running
docker-compose ps
```

You should see 7 containers running:
- agent1-monitoring
- agent2-resilience
- agent3-security
- agent4-performance
- agent5-automation
- unified-prometheus
- unified-grafana

### 5. Verify Deployment

```bash
# Check orchestrator health
curl http://localhost:8080/health

# Check all agents status
curl http://localhost:8080/api/overview

# View logs
docker-compose logs -f
```

### 6. Access Dashboards

Open your browser and navigate to:

**Grafana Dashboard**: http://YOUR_SERVER_IP:3000
- Username: `admin`
- Password: `admin` (change this immediately!)

### 7. Configure Router Syslog

Configure your routers to send syslog messages to the server:

**Cisco IOS:**
```
configure terminal
logging host YOUR_SERVER_IP
logging trap informational
logging facility local7
end
write memory
```

**Juniper:**
```
set system syslog host YOUR_SERVER_IP any any
commit
```

**MikroTik:**
```
/system logging action
add name=remote-server remote=YOUR_SERVER_IP target=remote

/system logging
add action=remote-server topics=info
```

### 8. Configure SNMP Traps (Optional)

**Cisco IOS:**
```
configure terminal
snmp-server host YOUR_SERVER_IP version 2c YOUR_COMMUNITY
snmp-server enable traps
end
write memory
```

**Juniper:**
```
set snmp trap-group FRAMEWORK target-ips YOUR_SERVER_IP
commit
```

## Post-Deployment Configuration

### Change Default Passwords

1. **Grafana Admin Password**
   - Login to Grafana
   - Go to Profile > Change Password
   - Set a strong password

2. **Update docker-compose.yml**
   ```yaml
   grafana:
     environment:
       - GF_SECURITY_ADMIN_PASSWORD=YOUR_STRONG_PASSWORD
   ```

### Enable HTTPS (Recommended)

Use nginx as reverse proxy:

```bash
# Install nginx
sudo apt install nginx -y

# Create nginx config
sudo nano /etc/nginx/sites-available/router-framework
```

Add this configuration:
```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/router-framework /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Set Up SSL with Let's Encrypt

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx -y

# Get certificate
sudo certbot --nginx -d YOUR_DOMAIN

# Auto-renewal is configured automatically
```

## Monitoring and Maintenance

### Daily Checks

```bash
# Check system health
curl http://localhost:8080/api/overview

# View recent logs
docker-compose logs --tail 100
```

### Weekly Tasks

1. Review Grafana dashboards
2. Check for failed agents
3. Review security alerts
4. Verify backup router status

### Monthly Tasks

1. Update system packages
2. Review and rotate logs
3. Test failover functionality
4. Backup configurations

### Backup Procedure

```bash
# Create backup directory
mkdir -p /backup/router-framework

# Backup configuration
cp router.yml /backup/router-framework/router.yml.$(date +%Y%m%d)

# Backup Grafana data
docker exec unified-grafana tar czf /tmp/grafana-backup.tar.gz /var/lib/grafana
docker cp unified-grafana:/tmp/grafana-backup.tar.gz /backup/router-framework/

# Backup Prometheus data
docker exec unified-prometheus tar czf /tmp/prometheus-backup.tar.gz /prometheus
docker cp unified-prometheus:/tmp/prometheus-backup.tar.gz /backup/router-framework/
```

## Troubleshooting

### Agents Not Starting

```bash
# Check container status
docker-compose ps

# View specific agent logs
docker-compose logs agent1-monitoring

# Restart specific agent
docker-compose restart agent1-monitoring
```

### No Data in Grafana

```bash
# Check Prometheus targets
curl http://localhost:9095/api/v1/targets

# Verify agent metrics
curl http://localhost:9090/metrics

# Check Grafana logs
docker-compose logs grafana
```

### High CPU Usage

```bash
# Check resource usage
docker stats

# Adjust monitoring intervals in router.yml
# Increase metrics_interval and health_check_interval
```

### Router Connection Issues

```bash
# Test SNMP connectivity
snmpwalk -v2c -c YOUR_COMMUNITY YOUR_ROUTER_IP system

# Test network connectivity
ping YOUR_ROUTER_IP

# Check firewall rules
sudo iptables -L -n
```

## Scaling for Multiple Routers

To monitor multiple router pairs:

1. Deploy separate orchestrator instances
2. Use different ports for each instance
3. Create separate Grafana dashboards
4. Use centralized Prometheus for aggregation

## Support and Updates

### Getting Help

1. Check logs: `docker-compose logs -f`
2. Review README.md
3. Check API health: `curl http://localhost:8080/health`

### Updating the Framework

```bash
# Stop services
docker-compose down

# Backup configuration
cp router.yml router.yml.backup

# Extract new version
tar -xzf router-framework-new.tar.gz

# Restore configuration
cp router.yml.backup router.yml

# Rebuild and start
docker-compose build
docker-compose up -d
```

## Production Checklist

- [ ] Server meets minimum requirements
- [ ] Docker and Docker Compose installed
- [ ] router.yml configured with correct IPs
- [ ] SNMP community strings updated
- [ ] All containers running (`docker-compose ps`)
- [ ] Grafana accessible and password changed
- [ ] Routers sending syslog to server
- [ ] SNMP connectivity verified
- [ ] Backup procedure configured
- [ ] Monitoring alerts configured
- [ ] SSL certificate installed (if using HTTPS)
- [ ] Firewall rules configured
- [ ] Documentation reviewed

## Security Recommendations

1. **Change all default passwords**
2. **Use SNMPv3 with authentication**
3. **Enable firewall rules**
4. **Use HTTPS for web interfaces**
5. **Restrict access to management ports**
6. **Regular security updates**
7. **Monitor access logs**
8. **Use strong SNMP community strings**

---

**Congratulations!** Your Router Framework is now deployed and monitoring your network infrastructure.
