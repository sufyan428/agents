FROM node:22-alpine

# Install system dependencies
RUN apk add --no-cache \
    bash \
    curl \
    iputils \
    net-snmp-tools \
    python3 \
    make \
    g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY src/ ./src/
COPY config/ ./config/

# Create necessary directories
RUN mkdir -p logs data

# Expose ports
# 9090 - Prometheus metrics endpoint
# 514 - Syslog (UDP)
# 3000 - Optional admin interface
EXPOSE 9090 514/udp 3000

# Inside the container this is the container network, not the host.
# docker-compose publishes these ports to 127.0.0.1 only.
ENV BIND_HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
# Drop privileges. node:alpine ships an unprivileged "node" user.
RUN mkdir -p /app/logs /app/data && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]