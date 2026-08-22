#!/bin/bash

# Resilience & Failover Agent - Quick Start Script
# This script helps you quickly deploy and test the agent

set -e

echo "========================================="
echo "Resilience & Failover Agent - Quick Start"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored messages
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed. Please install Docker first."
    exit 1
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed. Please install Docker Compose first."
    exit 1
fi

print_info "Docker and Docker Compose are installed."

# Check if config file exists
if [ ! -f "config/router.yml" ]; then
    print_warning "Configuration file not found. Creating from example..."
    cp config/router.yml.example config/router.yml
    print_info "Configuration file created: config/router.yml"
    print_warning "Please edit config/router.yml with your router details before starting."
    echo ""
    echo "Minimum required changes:"
    echo "  - primary.host: your primary router IP"
    echo "  - primary.community: your SNMP community string"
    echo "  - backup.host: your backup router IP"
    echo "  - backup.community: your SNMP community string"
    echo ""
    read -p "Press Enter to continue after editing configuration, or Ctrl+C to exit..."
else
    print_info "Configuration file found: config/router.yml"
fi

# Create necessary directories
print_info "Creating necessary directories..."
mkdir -p logs data monitoring

# Check if user wants to start the services
echo ""
read -p "Do you want to start all services (agent, Prometheus, Grafana)? [y/N] " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Starting all services..."
    docker-compose up -d
    
    print_info "Waiting for services to be healthy..."
    sleep 10
    
    # Check if agent is running
    if docker-compose ps resilience-failover-agent | grep -q "Up"; then
        print_info "Agent is running!"
    else
        print_error "Agent failed to start. Check logs with: docker-compose logs resilience-failover-agent"
        exit 1
    fi
    
    echo ""
    echo "========================================="
    print_info "Services started successfully!"
    echo "========================================="
    echo ""
    echo "Access Points:"
    echo "  - Agent Health:     http://localhost:9090/health"
    echo "  - Agent Status:     http://localhost:9090/status"
    echo "  - Prometheus:       http://localhost:9091"
    echo "  - Grafana Dashboard: http://localhost:3001 (admin/admin)"
    echo ""
    echo "Useful Commands:"
    echo "  - View logs:       docker-compose logs -f"
    echo "  - Stop services:   docker-compose down"
    echo "  - Restart agent:   docker-compose restart resilience-failover-agent"
    echo "  - Check health:    curl http://localhost:9090/health"
    echo ""
    
    # Test agent health
    print_info "Testing agent health..."
    if curl -s http://localhost:9090/health > /dev/null; then
        print_info "Agent is healthy and responding!"
        echo ""
        curl -s http://localhost:9090/health | jq .
    else
        print_warning "Agent is not yet responding. Please wait a moment and check logs."
    fi
    
else
    print_info "Services not started. You can start them later with: docker-compose up -d"
fi

echo ""
print_info "For detailed testing procedures, see: test.md"
print_info "For configuration options, see: README.md"
echo ""
print_info "Quick Start complete!"