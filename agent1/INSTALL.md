# Installation Guide - Router Monitoring Agent

This guide provides detailed installation instructions for various deployment scenarios.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Installation](#local-development-installation)
3. [Production Installation](#production-installation)
4. [Docker Installation](#docker-installation)
5. [Kubernetes Installation](#kubernetes-installation)
6. [Post-Installation Steps](#post-installation-steps)

## Prerequisites

### Required Software

- **Node.js**: Version 18.0.0 or higher
- **npm**: Version 9.0.0 or higher (comes with Node.js)
- **Git**: For cloning the repository (optional)

### Optional Software

- **Docker**: Version 20.10 or higher (for containerized deployment)
- **Docker Compose**: Version 2.0 or higher
- **Prometheus**: For metrics storage
- **Grafana**: For visualization

### System Requirements

**Minimum:**
- CPU: 1 core
- RAM: 512 MB
- Disk: 100 MB
- Network: 100 Mbps

**Recommended:**
- CPU: 2 cores
- RAM: 1 GB
- Disk: 1 GB
- Network: 1 Gbps

## Local Development Installation

### Step 1: Obtain the Project

**Option A: Clone from Git Repository**
```bash
git clone <repository-url>
cd monitoring-agent
```

**Option B: Download Archive**
1. Download the project archive
2. Extract to a directory
3. Navigate to the project directory:
```bash
cd monitoring-agent
```

### Step 2: Install Node.js

If Node.js is not already installed:

**macOS (using Homebrew):**
```bash
brew install node
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS/RHEL:**
```bash
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

**Windows:**
1. Download from [nodejs.org](https://nodejs.org/)
2. Run the installer with default options

### Step 3: Verify Installation

```bash
node --version
npm --version
```

Expected output:
```
v18.x.x
9.x.x
```

### Step 4: Install Dependencies

```bash
npm install
```

This will:
- Download all packages listed in `package.json`
- Create a `node_modules` directory
- Generate a `package-lock.json` file

### Step 5: Run Tests

Verify everything is working:

```bash
npm test
```

All tests should pass.

### Step 6: Configure the Agent

See [Configuration](#configuration) section below.

## Production Installation

### Step 1: System Preparation

**Create a dedicated user (Linux/macOS):**
```bash
sudo adduser --system --group monitoring
sudo mkdir -p /opt/monitoring-agent
sudo chown monitoring:monitoring /opt/monitoring-agent
```

**Create installation directory:**
```bash
sudo mkdir -p /opt/monitoring-agent
```

### Step 2: Copy Project Files

```bash
# Copy project files to installation directory
sudo cp -r . /opt/monitoring-agent/

# Set ownership
sudo chown -R monitoring:monitoring /opt/monitoring-agent

# Navigate to installation directory
cd /opt/monitoring-agent
```

### Step 3: Install Dependencies

```bash
sudo -u monitoring npm install --production
```

The `--production` flag installs only runtime dependencies, skipping development tools.

### Step 4: Create Directories

```bash
sudo -u monitoring mkdir -p /opt/monitoring-agent/logs
sudo -u monitoring mkdir -p /opt/monitoring-agent/config
```

### Step 5: Configure Environment

```bash
# Copy example environment file
sudo cp .env.example .env

# Edit with your configuration
sudo nano .env
```

### Step 6: Create Systemd Service

Create a systemd service file:

```bash
sudo nano /etc/systemd/system/router-monitoring-agent.service
```

Add the following:

```ini
[Unit]
Description=Router Monitoring Agent
After=network.target

[Service]
Type=simple
User=monitoring
Group=monitoring
WorkingDirectory=/opt/monitoring-agent
ExecStart=/usr/bin/node /opt/monitoring-agent/src/main.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/opt/monitoring-agent/.env

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=router-monitoring-agent

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/monitoring-agent/logs

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable router-monitoring-agent
sudo systemctl start router-monitoring-agent
```

Check service status:

```bash
sudo systemctl status router-monitoring-agent
```

### Step 7: Configure Firewall

Open required ports:

```bash
# Ubuntu/Debian (UFW)
sudo ufw allow 3000/tcp    # HTTP server
sudo ufw allow 2055/udp    # NetFlow
sudo ufw allow 514/udp     # Syslog

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=2055/udp
sudo firewall-cmd --permanent --add-port=514/udp
sudo firewall-cmd --reload
```

## Docker Installation

### Step 1: Install Docker

**Ubuntu/Debian:**
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

**CentOS/RHEL:**
```bash
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum install -y docker-ce docker-ce-cli containerd.io
```

**macOS:**
```bash
brew install --cask docker
```

### Step 2: Verify Docker Installation

```bash
docker --version
docker-compose --version
```

### Step 3: Build Docker Image

```bash
docker build -t router-monitoring-agent .
```

### Step 4: Prepare Configuration

```bash
# Copy example environment file
cp .env.example .env

# Edit with your configuration
nano .env
```

### Step 5: Run Container

**Using docker run:**
```bash
docker run -d \
  --name monitoring-agent \
  --restart unless-stopped \
  -p 3000:3000 \
  -p 2055:2055/udp \
  -p 514:514/udp \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/logs:/app/logs \
  --env-file .env \
  router-monitoring-agent
```

**Using docker-compose:**
```bash
docker-compose up -d
```

### Step 6: Verify Container

```bash
# Check container status
docker ps

# View logs
docker logs -f monitoring-agent

# Check health
curl http://localhost:3000/health
```

## Kubernetes Installation

### Step 1: Create Namespace

```bash
kubectl create namespace monitoring
```

### Step 2: Create ConfigMap

```bash
kubectl create configmap router-monitoring-config \
  --from-file=config/router.yml \
  --from-file=config/thresholds.yml \
  -n monitoring
```

### Step 3: Create Secret

```bash
kubectl create secret generic router-monitoring-secret \
  --from-env-file=.env \
  -n monitoring
```

### Step 4: Create Deployment

Create `k8s-deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: router-monitoring-agent
  namespace: monitoring
  labels:
    app: router-monitoring-agent
spec:
  replicas: 1
  selector:
    matchLabels:
      app: router-monitoring-agent
  template:
    metadata:
      labels:
        app: router-monitoring-agent
    spec:
      containers:
      - name: monitoring-agent
        image: router-monitoring-agent:latest
        ports:
        - containerPort: 3000
          name: http
        - containerPort: 2055
          name: netflow
          protocol: UDP
        - containerPort: 514
          name: syslog
          protocol: UDP
        envFrom:
        - secretRef:
            name: router-monitoring-secret
        volumeMounts:
        - name: config
          mountPath: /app/config
          readOnly: true
        - name: logs
          mountPath: /app/logs
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: config
        configMap:
          name: router-monitoring-config
      - name: logs
        emptyDir: {}
```

Deploy:

```bash
kubectl apply -f k8s-deployment.yaml
```

### Step 5: Create Service

Create `k8s-service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: router-monitoring-agent
  namespace: monitoring
  labels:
    app: router-monitoring-agent
spec:
  type: ClusterIP
  ports:
  - port: 3000
    targetPort: 3000
    name: http
  - port: 2055
    targetPort: 2055
    name: netflow
    protocol: UDP
  - port: 514
    targetPort: 514
    name: syslog
    protocol: UDP
  selector:
    app: router-monitoring-agent
```

Deploy:

```bash
kubectl apply -f k8s-service.yaml
```

### Step 6: Verify Deployment

```bash
# Check pods
kubectl get pods -n monitoring

# Check service
kubectl get svc -n monitoring

# View logs
kubectl logs -f deployment/router-monitoring-agent -n monitoring
```

## Configuration

### Router Configuration

Edit `config/router.yml`:

```yaml
routers:
  - name: "Router-Primary"
    ip: "192.168.1.1"
    snmp_community: "public"
    snmp_version: "2c"
    snmp_port: 161
    poll_interval: 30
    enabled: true
```

### Threshold Configuration

Edit `config/thresholds.yml`:

```yaml
cpu:
  warning: 75
  critical: 90

memory:
  warning: 80
  critical: 90
```

### Environment Variables

Edit `.env`:

```bash
PORT=3000
LOG_LEVEL=info
SMTP_HOST=smtp.example.com
SMTP_USER=your-email@example.com
SMTP_PASS=your-password
ALERT_EMAIL_RECIPIENT=admin@example.com
```

## Post-Installation Steps

### 1. Verify Installation

```bash
# Check health
curl http://localhost:3000/health

# Check status
curl http://localhost:3000/status

# View metrics
curl http://localhost:3000/metrics
```

### 2. Test SNMP Connectivity

```bash
snmpwalk -v2c -c public 192.168.1.1 1.3.6.1.2.1.1.3.0
```

### 3. Send Test Alert

```bash
curl -X POST http://localhost:3000/test
```

### 4. Monitor Logs

```bash
# Local/Docker
tail -f logs/combined.log

# Systemd
sudo journalctl -u router-monitoring-agent -f

# Kubernetes
kubectl logs -f deployment/router-monitoring-agent -n monitoring
```

### 5. Set Up Monitoring

- Configure Prometheus to scrape `/metrics` endpoint
- Create Grafana dashboards
- Set up alert rules

### 6. Configure Alerts

- Set up email alerts via SMTP
- Configure API webhooks
- Test alert delivery

## Upgrades

### Local/Production

```bash
cd /opt/monitoring-agent
git pull origin main
sudo -u monitoring npm install --production
sudo systemctl restart router-monitoring-agent
```

### Docker

```bash
docker pull router-monitoring-agent:latest
docker-compose down
docker-compose up -d
```

### Kubernetes

```bash
kubectl set image deployment/router-monitoring-agent \
  monitoring-agent=router-monitoring-agent:latest \
  -n monitoring
```

## Uninstallation

### Local/Production

```bash
sudo systemctl stop router-monitoring-agent
sudo systemctl disable router-monitoring-agent
sudo rm /etc/systemd/system/router-monitoring-agent.service
sudo systemctl daemon-reload
sudo rm -rf /opt/monitoring-agent
sudo deluser monitoring
```

### Docker

```bash
docker-compose down
docker rmi router-monitoring-agent
```

### Kubernetes

```bash
kubectl delete -f k8s-service.yaml
kubectl delete -f k8s-deployment.yaml
kubectl delete configmap router-monitoring-config -n monitoring
kubectl delete secret router-monitoring-secret -n monitoring
kubectl delete namespace monitoring
```

## Support

For issues or questions:
- Check logs in `logs/` directory
- Review documentation in `docs/`
- Run tests: `npm test`
- Check status: `http://localhost:3000/status`

## Security Considerations

1. **SNMP Security**: Use SNMP v3 in production environments
2. **Network Isolation**: Run monitoring on a separate network segment
3. **Firewall Rules**: Limit access to monitoring ports
4. **HTTPS**: Use HTTPS for API endpoints in production
5. **Credentials**: Store SMTP credentials securely
6. **Regular Updates**: Keep Node.js and dependencies updated

## Performance Tuning

1. **Polling Intervals**: Adjust based on router count and network capacity
2. **Resource Limits**: Set appropriate CPU and memory limits
3. **Log Rotation**: Configure log rotation to prevent disk space issues
4. **Metric Retention**: Adjust Prometheus retention policy as needed

## Troubleshooting

See [setup.md](setup.md) for detailed troubleshooting steps.

## Next Steps

After installation:
1. Configure your routers in `config/router.yml`
2. Adjust thresholds in `config/thresholds.yml`
3. Set up email alerts in `.env`
4. Install Prometheus and Grafana for visualization
5. Create monitoring dashboards
6. Set up alert rules

Congratulations! Your Router Monitoring Agent is now installed and ready to monitor your routers.