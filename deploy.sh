#!/bin/bash
set -e

# ============================================
# KubeEZ Production Deploy Script
# Domain: k8scluster.space
# Method: Cloudflare Tunnel (no host Nginx needed)
# ============================================

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}"
echo "╔═══════════════════════════════════════════════════════╗"
echo "║                                                       ║"
echo "║   🚀 KubeEZ Production Deployment                    ║"
echo "║   Domain: k8scluster.space                           ║"
echo "║   Method: Cloudflare Tunnel                          ║"
echo "║                                                       ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# --- Step 1: Check prerequisites ---
echo -e "${YELLOW}[1/4] Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Install it first:${NC}"
    echo "   curl -fsSL https://get.docker.com | sh"
    exit 1
fi

if ! docker compose version &> /dev/null && ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}❌ Docker Compose is not installed.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker and Docker Compose are installed${NC}"

# Determine compose command
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

# --- Step 2: Generate APP_SECRET if not set ---
echo -e "${YELLOW}[2/4] Setting up environment...${NC}"

if [ ! -f .env ]; then
    echo -e "${CYAN}   Creating .env from .env.production template...${NC}"
    cp .env.production .env

    # Generate secure APP_SECRET
    APP_SECRET=$(openssl rand -hex 32)
    sed -i "s|APP_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32|APP_SECRET=${APP_SECRET}|" .env

    echo -e "${GREEN}✓ Generated secure APP_SECRET${NC}"
else
    echo -e "${GREEN}✓ .env file already exists${NC}"

    if grep -q "CHANGE_ME" .env; then
        APP_SECRET=$(openssl rand -hex 32)
        sed -i "s|APP_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32|APP_SECRET=${APP_SECRET}|" .env
        echo -e "${GREEN}✓ Generated secure APP_SECRET (was placeholder)${NC}"
    fi
fi

# --- Step 3: Build and start containers ---
echo -e "${YELLOW}[3/4] Building and starting containers...${NC}"
$COMPOSE_CMD -f docker-compose.prod.yml down 2>/dev/null || true
$COMPOSE_CMD -f docker-compose.prod.yml build --no-cache
$COMPOSE_CMD -f docker-compose.prod.yml up -d

# --- Step 4: Health check ---
echo -e "${YELLOW}[4/4] Running health check...${NC}"
sleep 10

MAX_RETRIES=12
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -sf http://localhost:8090/api/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ KubeEZ health check passed!${NC}"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "   Waiting for services to start... ($RETRY_COUNT/$MAX_RETRIES)"
    sleep 5
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo -e "${RED}❌ Health check failed after ${MAX_RETRIES} retries${NC}"
    echo "   Check logs with: $COMPOSE_CMD -f docker-compose.prod.yml logs"
    exit 1
fi

# --- Done! ---
echo ""
echo -e "${GREEN}"
echo "╔═══════════════════════════════════════════════════════╗"
echo "║                                                       ║"
echo "║   ✅ KubeEZ Containers are RUNNING!                   ║"
echo "║                                                       ║"
echo "║   🐳 Local: http://localhost:8090                     ║"
echo "║   🔧 API:   http://localhost:8090/api/health          ║"
echo "║                                                       ║"
echo "║   📋 Next Step: Add Cloudflare Tunnel hostname        ║"
echo "║                                                       ║"
echo "║   Go to Cloudflare Dashboard:                         ║"
echo "║   → Zero Trust → Networks → Tunnels                  ║"
echo "║   → Your tunnel → Public Hostname → Add              ║"
echo "║                                                       ║"
echo "║   Hostname: k8scluster.space                         ║"
echo "║   Service:  HTTP → localhost:8090                     ║"
echo "║                                                       ║"
echo "║   📊 View logs:                                       ║"
echo "║   docker compose -f docker-compose.prod.yml logs -f   ║"
echo "║                                                       ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${CYAN}Container Status:${NC}"
$COMPOSE_CMD -f docker-compose.prod.yml ps
