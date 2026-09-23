#!/usr/bin/env bash
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

printf "${CYAN}\n"
printf "╔═══════════════════════════════════════════════════════╗\n"
printf "║                                                       ║\n"
printf "║   🚀 KubeEZ Production Deployment                    ║\n"
printf "║   Domain: k8scluster.space                           ║\n"
printf "║   Method: Cloudflare Tunnel                          ║\n"
printf "║                                                       ║\n"
printf "╚═══════════════════════════════════════════════════════╝\n"
printf "${NC}\n"

# --- Step 1: Check prerequisites ---
printf "${YELLOW}[1/4] Checking prerequisites...${NC}\n"

if ! command -v docker >/dev/null 2>&1; then
    printf "${RED}❌ Docker command not found in PATH. Install it or check permissions:${NC}\n"
    printf "   curl -fsSL https://get.docker.com | sh\n"
    exit 1
fi

if ! docker compose version >/dev/null 2>&1 && ! command -v docker-compose >/dev/null 2>&1; then
    printf "${RED}❌ Docker Compose is not installed.${NC}\n"
    exit 1
fi

printf "${GREEN}✓ Docker and Docker Compose are installed${NC}\n"

# Determine compose command
if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

# --- Step 2: Generate APP_SECRET if not set ---
printf "${YELLOW}[2/4] Setting up environment...${NC}\n"

if [ ! -f .env ]; then
    printf "${CYAN}   Creating .env from .env.production template...${NC}\n"
    cp .env.production .env

    # Generate secure APP_SECRET
    APP_SECRET=$(openssl rand -hex 32 2>/dev/null || date +%s | md5sum | head -c 32)
    sed -i "s|APP_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32|APP_SECRET=${APP_SECRET}|" .env

    printf "${GREEN}✓ Generated secure APP_SECRET${NC}\n"
else
    printf "${GREEN}✓ .env file already exists${NC}\n"

    if grep -q "CHANGE_ME" .env 2>/dev/null; then
        APP_SECRET=$(openssl rand -hex 32 2>/dev/null || date +%s | md5sum | head -c 32)
        sed -i "s|APP_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32|APP_SECRET=${APP_SECRET}|" .env
        printf "${GREEN}✓ Generated secure APP_SECRET (was placeholder)${NC}\n"
    fi
fi

# --- Step 3: Build and start containers ---
printf "${YELLOW}[3/4] Building and starting containers...${NC}\n"
$COMPOSE_CMD -f docker-compose.prod.yml down >/dev/null 2>&1 || true
$COMPOSE_CMD -f docker-compose.prod.yml build --no-cache
$COMPOSE_CMD -f docker-compose.prod.yml up -d

# --- Step 4: Health check ---
printf "${YELLOW}[4/4] Running health check...${NC}\n"
sleep 10

MAX_RETRIES=12
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -sf http://localhost:8090/api/health > /dev/null 2>&1; then
        printf "${GREEN}✓ KubeEZ health check passed!${NC}\n"
        break
    fi
    RETRY_COUNT=$((RETRY_COUNT + 1))
    printf "   Waiting for services to start... ($RETRY_COUNT/$MAX_RETRIES)\n"
    sleep 5
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    printf "${RED}❌ Health check failed after ${MAX_RETRIES} retries${NC}\n"
    printf "   Check logs with: $COMPOSE_CMD -f docker-compose.prod.yml logs\n"
    exit 1
fi

# --- Done! ---
printf "\n"
printf "${GREEN}"
printf "╔═══════════════════════════════════════════════════════╗\n"
printf "║                                                       ║\n"
printf "║   ✅ KubeEZ Containers are RUNNING!                   ║\n"
printf "║                                                       ║\n"
printf "║   🐳 Local: http://localhost:8090                     ║\n"
printf "║   🔧 API:   http://localhost:8090/api/health          ║"
printf "║                                                       ║"
printf "║   📋 Next Step: Add Cloudflare Tunnel hostname        ║\n"
printf "║                                                       ║"
printf "║   Go to Cloudflare Dashboard:                         ║"
printf "║   → Zero Trust → Networks → Tunnels                  ║"
printf "║   → Your tunnel → Public Hostname → Add              ║"
printf "║                                                       ║"
printf "║   Hostname: k8scluster.space                         ║"
printf "║   Service:  HTTP → localhost:8090                     ║"
printf "║                                                       ║"
printf "║   📊 View logs:                                       ║"
printf "║   docker compose -f docker-compose.prod.yml logs -f   ║"
printf "║                                                       ║"
printf "╚═══════════════════════════════════════════════════════╝\n"
printf "${NC}\n"

printf "${CYAN}Container Status:${NC}\n"
$COMPOSE_CMD -f docker-compose.prod.yml ps
