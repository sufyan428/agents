FROM node:18-alpine

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
RUN npm ci --only=production

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

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9090/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "src/index.js"]