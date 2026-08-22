FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY router.yml ./

# Create logs directory
RUN mkdir -p logs

# Expose API port
EXPOSE 8080

# Start orchestrator
ENV BIND_HOST=0.0.0.0

# Drop privileges. node:alpine ships an unprivileged "node" user.
RUN mkdir -p /app/logs /app/data && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]
