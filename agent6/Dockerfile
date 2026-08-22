FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY src/ ./src/
COPY router.yml ./

# Create logs directory
RUN mkdir -p logs

# Expose API port
EXPOSE 8080

# Start orchestrator
CMD ["node", "src/index.js"]
