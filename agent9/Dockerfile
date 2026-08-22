FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p logs

EXPOSE 9098

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:9098/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

ENV BIND_HOST=0.0.0.0

# Drop privileges. node:alpine ships an unprivileged "node" user.
RUN mkdir -p /app/logs /app/data && chown -R node:node /app
USER node

CMD ["npm", "start"]
