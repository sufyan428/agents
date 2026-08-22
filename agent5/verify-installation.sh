#!/bin/bash

# Automation & Governance Agent - Installation Verification Script
# This script verifies that all components are correctly installed and configured

echo "=========================================="
echo "Automation & Governance Agent"
echo "Installation Verification Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counter for results
PASSED=0
FAILED=0
WARNINGS=0

# Function to print test result
print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓ PASS${NC}: $2"
        ((PASSED++))
    elif [ $1 -eq 2 ]; then
        echo -e "${YELLOW}⚠ WARNING${NC}: $2"
        ((WARNINGS++))
    else
        echo -e "${RED}✗ FAIL${NC}: $2"
        ((FAILED++))
    fi
}

echo "Checking Docker Installation..."
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version)
    print_result 0 "Docker is installed: $DOCKER_VERSION"
else
    print_result 1 "Docker is not installed"
fi
echo ""

echo "Checking Docker Compose Installation..."
if command -v docker-compose &> /dev/null; then
    COMPOSE_VERSION=$(docker-compose --version)
    print_result 0 "Docker Compose is installed: $COMPOSE_VERSION"
else
    print_result 1 "Docker Compose is not installed"
fi
echo ""

echo "Checking Required Files..."
FILES=(
    "package.json"
    "router.yml"
    "config.yml"
    "Dockerfile"
    "docker-compose.yml"
    "prometheus.yml"
    "grafana-datasources.yml"
    "src/index.js"
)

for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        print_result 0 "File exists: $file"
    else
        print_result 1 "File missing: $file"
    fi
done
echo ""

echo "Checking Module Files..."
MODULES=(
    "src/modules/policyChecker.js"
    "src/modules/configManager.js"
    "src/modules/selfHealing.js"
    "src/modules/auditReporter.js"
    "src/modules/taskScheduler.js"
)

for module in "${MODULES[@]}"; do
    if [ -f "$module" ]; then
        print_result 0 "Module exists: $module"
    else
        print_result 1 "Module missing: $module"
    fi
done
echo ""

echo "Checking Utility Files..."
UTILS=(
    "src/utils/logger.js"
    "src/utils/snmpClient.js"
    "src/utils/syslogListener.js"
    "src/utils/metrics.js"
    "src/utils/configLoader.js"
)

for util in "${UTILS[@]}"; do
    if [ -f "$util" ]; then
        print_result 0 "Utility exists: $util"
    else
        print_result 1 "Utility missing: $util"
    fi
done
echo ""

echo "Checking Policy Files..."
POLICY_COUNT=$(find policies -name "*.json" 2>/dev/null | wc -l)
if [ $POLICY_COUNT -gt 0 ]; then
    print_result 0 "Found $POLICY_COUNT policy files in policies/"
    for policy in policies/*.json; do
        if [ -f "$policy" ]; then
            print_result 0 "  - $(basename $policy)"
        fi
    done
else
    print_result 1 "No policy files found in policies/"
fi
echo ""

echo "Checking Documentation..."
DOCS=(
    "README.md"
    "QUICKSTART.md"
    "test.md"
    "PROJECT_STRUCTURE.md"
)

for doc in "${DOCS[@]}"; do
    if [ -f "$doc" ]; then
        print_result 0 "Documentation exists: $doc"
    else
        print_result 1 "Documentation missing: $doc"
    fi
done
echo ""

echo "Checking Configuration Files..."
if [ -f "router.yml" ]; then
    print_result 0 "router.yml exists"
    
    # Check if router.yml has routers configured
    if grep -q "routers:" router.yml && grep -q "host:" router.yml; then
        print_result 0 "router.yml contains router configurations"
    else
        print_result 2 "router.yml may not have routers configured - please verify"
    fi
else
    print_result 1 "router.yml is missing"
fi

if [ -f "config.yml" ]; then
    print_result 0 "config.yml exists"
else
    print_result 1 "config.yml is missing"
fi
echo ""

echo "Checking Dashboard..."
if [ -f "dashboards/governance-dashboard.json" ]; then
    print_result 0 "Grafana dashboard exists"
else
    print_result 2 "Grafana dashboard not found in dashboards/"
fi
echo ""

echo "Checking Node.js Version (if installed)..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    print_result 0 "Node.js is installed: $NODE_VERSION"
    
    # Check if version is >= 18
    MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'v' -f2 | cut -d'.' -f1)
    if [ $MAJOR_VERSION -ge 18 ]; then
        print_result 0 "Node.js version is compatible (>= 18)"
    else
        print_result 2 "Node.js version $NODE_VERSION may not be compatible (requires 18+)"
    fi
else
    print_result 2 "Node.js is not installed locally (Docker will provide runtime)"
fi
echo ""

echo "Checking for Required Directories..."
DIRS=("src/modules" "src/utils" "policies" "dashboards" "logs" "configs")
for dir in "${DIRS[@]}"; do
    if [ -d "$dir" ]; then
        print_result 0 "Directory exists: $dir"
    else
        print_result 2 "Directory missing: $dir (will be created automatically)"
    fi
done
echo ""

echo "Checking Port Availability..."
PORTS=(9091 9090 3000)
for port in "${PORTS[@]}"; do
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        print_result 2 "Port $port is already in use (may cause conflicts)"
    else
        print_result 0 "Port $port is available"
    fi
done
echo ""

echo "=========================================="
echo "Verification Summary"
echo "=========================================="
echo -e "${GREEN}Passed:${NC} $PASSED"
echo -e "${YELLOW}Warnings:${NC} $WARNINGS"
echo -e "${RED}Failed:${NC} $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All critical checks passed!${NC}"
    echo ""
    echo "You can now start the agent with:"
    echo "  docker-compose up -d"
    echo ""
    echo "Then access:"
    echo "  - Agent: http://localhost:9091"
    echo "  - Prometheus: http://localhost:9090"
    echo "  - Grafana: http://localhost:3000 (admin/admin)"
    exit 0
else
    echo -e "${RED}Some critical checks failed. Please resolve the issues above before proceeding.${NC}"
    exit 1
fi