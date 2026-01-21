#!/bin/bash
# ==========================================
# KubeEZ - VPS Quickstart Script
# ==========================================
# Run this script on your fresh Ubuntu/Debian VPS to setup KubeEZ.

set -e

echo "🚀 Starting KubeEZ Setup..."

# 1. Install Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
    echo "✓ Docker Installed"
else
    echo "✓ Docker already installed"
fi

# 2. Install Git
sudo apt-get update
sudo apt-get install -y git

# 3. Instructions
echo ""
echo "=========================================="
echo "✅ dependency installation complete!"
echo "=========================================="
echo ""
echo "Now run these two commands to launch:"
echo ""
echo "  1. git clone https://github.com/YOUR_GITHUB_USERNAME/kubeez.git"
echo "  2. cd kubeez && sudo docker compose up -d --build"
echo ""
echo "Then access via http://$(curl -s ifconfig.me)"
echo "=========================================="
