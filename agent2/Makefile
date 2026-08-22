.PHONY: help install build up down restart logs clean test health status

# Default target
help:
	@echo "Resilience & Failover Agent - Makefile Commands"
	@echo "=============================================="
	@echo ""
	@echo "Development:"
	@echo "  make install    - Install dependencies"
	@echo "  make build      - Build Docker image"
	@echo "  make dev        - Start in development mode"
	@echo ""
	@echo "Operations:"
	@echo "  make up         - Start all services"
	@echo "  make down       - Stop all services"
	@echo "  make restart    - Restart services"
	@echo "  make logs       - View logs"
	@echo "  make clean      - Remove containers and volumes"
	@echo ""
	@echo "Monitoring:"
	@echo "  make health     - Check agent health"
	@echo "  make status     - Get detailed status"
	@echo "  make metrics    - View Prometheus metrics"
	@echo ""
	@echo "Testing:"
	@echo "  make test       - Run tests"
	@echo ""
	@echo "Utilities:"
	@echo "  make shell      - Access agent container shell"
	@echo "  make backup     - Backup configuration and state"

# Install dependencies
install:
	@echo "Installing dependencies..."
	npm install

# Build Docker image
build:
	@echo "Building Docker image..."
	docker build -t resilience-failover-agent .

# Start in development mode
dev:
	@echo "Starting in development mode..."
	docker-compose up

# Start all services
up:
	@echo "Starting all services..."
	docker-compose up -d
	@echo "Services started!"
	@echo "  Agent Health: http://localhost:9090/health"
	@echo "  Prometheus:   http://localhost:9091"
	@echo "  Grafana:      http://localhost:3001"

# Stop all services
down:
	@echo "Stopping all services..."
	docker-compose down

# Restart services
restart:
	@echo "Restarting services..."
	docker-compose restart
	@echo "Services restarted!"

# View logs
logs:
	@echo "Following logs (Ctrl+C to exit)..."
	docker-compose logs -f

# Remove containers and volumes
clean:
	@echo "Cleaning up..."
	docker-compose down -v
	docker system prune -f
	@echo "Cleanup complete!"

# Check health
health:
	@echo "Checking agent health..."
	@curl -s http://localhost:9090/health | jq . || echo "Agent not responding"

# Get detailed status
status:
	@echo "Getting detailed status..."
	@curl -s http://localhost:9090/status | jq .

# View metrics
metrics:
	@echo "Viewing Prometheus metrics..."
	@curl -s http://localhost:9090/metrics | head -50

# Run tests
test:
	@echo "Running tests..."
	npm test

# Access container shell
shell:
	@echo "Accessing agent container shell..."
	docker exec -it resilience-failover-agent sh

# Backup configuration and state
backup:
	@echo "Creating backup..."
	@mkdir -p backups
	@tar -czf backups/config-backup-$$(date +%Y%m%d-%H%M%S).tar.gz config/ data/
	@echo "Backup created in backups/"

# Lint code
lint:
	@echo "Linting code..."
	npm run lint || echo "No lint script configured"

# Format code
format:
	@echo "Formatting code..."
	npm run format || echo "No format script configured"

# Show container stats
stats:
	@echo "Container statistics:"
	@docker stats --no-stream resilience-failover-agent

# Rebuild and restart
rebuild: build down up
	@echo "Rebuild and restart complete!"