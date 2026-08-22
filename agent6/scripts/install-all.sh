#!/bin/bash

# Router Framework Orchestrator - Installation Script
# This script installs dependencies for all agents

set -e

echo "=========================================="
echo "Router Framework - Installing Dependencies"
echo "=========================================="

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BASE_DIR="$(dirname "$SCRIPT_DIR")"

# Function to install dependencies for an agent
install_agent() {
    local agent_name=$1
    local agent_dir="$BASE_DIR/../$agent_name"
    
    if [ -d "$agent_dir" ]; then
        echo ""
        echo "Installing dependencies for $agent_name..."
        cd "$agent_dir"
        
        if [ -f "package.json" ]; then
            npm install
            echo "✓ $agent_name dependencies installed"
        else
            echo "⚠ No package.json found for $agent_name"
        fi
    else
        echo "⚠ Directory not found: $agent_dir"
    fi
}

# Install dependencies for all agents
install_agent "agent1"
install_agent "agent2"
install_agent "agent3"
install_agent "agent4"
install_agent "agent5"

# Install orchestrator dependencies
echo ""
echo "Installing dependencies for orchestrator (agent6)..."
cd "$BASE_DIR"
npm install
echo "✓ Orchestrator dependencies installed"

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "1. Edit router.yml with your router IP addresses"
echo "2. Run: docker-compose up -d"
echo "3. Access Grafana at http://localhost:3000"
echo ""
