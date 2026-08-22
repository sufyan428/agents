FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    iputils-ping \
    net-tools \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application files
COPY agent.js ./
COPY router.yml ./
COPY modules ./modules

# Create logs directory
RUN mkdir -p logs

# Expose metrics port
EXPOSE 9091

# Expose syslog port
EXPOSE 514/udp

# Inside the container this is the container network, not the host.
# docker-compose publishes these ports to 127.0.0.1 only.
ENV BIND_HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9091/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the agent
# Drop privileges. node:alpine ships an unprivileged "node" user.
RUN mkdir -p /app/logs /app/data && chown -R node:node /app
USER node

CMD ["node", "agent.js"]