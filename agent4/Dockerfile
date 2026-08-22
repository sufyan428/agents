FROM node:18-slim

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
RUN npm install --production

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

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9091/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the agent
CMD ["node", "agent.js"]