# Dockerfile for Router Monitoring Agent

FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY src/ ./src/
COPY config/ ./config/

# Create logs directory
RUN mkdir -p /app/logs

# Create non-root user for security
RUN addgroup -g 1001 -S monitoring && \
    adduser -S monitoring -u 1001 && \
    chown -R monitoring:monitoring /app

# Switch to non-root user
USER monitoring

# Expose ports
# 3000: HTTP server (metrics, status, health)
# 2055: NetFlow (UDP)
# 514: Syslog (UDP)
EXPOSE 3000 2055/udp 514/udp

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "src/main.js"]