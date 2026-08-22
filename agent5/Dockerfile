FROM node:22-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose metrics port
EXPOSE 9091

# Inside the container this is the container network, not the host.
# docker-compose publishes these ports to 127.0.0.1 only.
ENV BIND_HOST=0.0.0.0

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9091/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
# Drop privileges. node:alpine ships an unprivileged "node" user.
RUN mkdir -p /app/logs /app/data && chown -R node:node /app
USER node

CMD ["npm", "start"]
