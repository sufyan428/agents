# Quick Start Guide

## For WiFi Router Organizations

This is the **simplest possible** guide to get all 5 router monitoring agents running.

### Step 1: Edit Configuration (2 minutes)

Open `router.yml` and change these 4 values:

```yaml
Line 7:  host: "192.168.1.1"              # Your primary router IP
Line 8:  snmp_community: "public"          # Your SNMP community

Line 16: host: "192.168.1.2"              # Your backup router IP  
Line 17: snmp_community: "public"          # Your SNMP community
```

### Step 2: Install (5 minutes)

```bash
cd agent6
bash scripts/install-all.sh
```

Wait for all dependencies to install.

### Step 3: Start (1 minute)

```bash
docker-compose up -d
```

### Step 4: Verify (1 minute)

Open your browser:
- **Dashboard**: http://localhost:3000
- **Login**: admin / admin

You should see all 5 agents monitoring your routers!

## What You Get

✅ **Agent 1**: Monitoring (CPU, memory, interfaces)  
✅ **Agent 2**: Automatic failover to backup router  
✅ **Agent 3**: Security & intrusion detection  
✅ **Agent 4**: Performance optimization  
✅ **Agent 5**: Compliance & self-healing  

## Useful Commands

```bash
# View all logs
docker-compose logs -f

# Check status
curl http://localhost:8080/api/overview

# Restart everything
docker-compose restart

# Stop everything
docker-compose down
```

## Need Help?

See `README.md` for detailed documentation.
See `DEPLOYMENT_GUIDE.md` for production deployment.

---

**That's it! Your router monitoring framework is now running.**
