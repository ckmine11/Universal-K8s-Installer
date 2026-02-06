#!/bin/bash

# KubeEZ - Setup Passwordless Sudo
# This script configures the current user to have passwordless sudo access
# Required for KubeEZ automation to work with non-root users

set -e

echo "========================================="
echo "Setting up Passwordless Sudo"
echo "========================================="

CURRENT_USER=$(whoami)

if [ "$CURRENT_USER" = "root" ]; then
    echo "⚠️  You are running as root. This script is for non-root users."
    echo "If you want to use a non-root user, please run this script as that user."
    exit 0
fi

echo "Current user: $CURRENT_USER"
echo ""
echo "This script will configure passwordless sudo for user: $CURRENT_USER"
echo "You will need to enter your sudo password ONE TIME."
echo ""

# Check if user already has passwordless sudo
if sudo -n true 2>/dev/null; then
    echo "✓ User $CURRENT_USER already has passwordless sudo configured"
    exit 0
fi

# Create sudoers file for the user
SUDOERS_FILE="/etc/sudoers.d/kubeez-${CURRENT_USER}"

echo "Creating sudoers configuration..."
echo "${CURRENT_USER} ALL=(ALL) NOPASSWD:ALL" | sudo tee "$SUDOERS_FILE" > /dev/null

# Set correct permissions (sudoers files must be 0440)
sudo chmod 0440 "$SUDOERS_FILE"

# Verify the configuration
if sudo -n true 2>/dev/null; then
    echo ""
    echo "========================================="
    echo "✓ Passwordless sudo configured successfully!"
    echo "========================================="
    echo ""
    echo "User $CURRENT_USER can now run sudo commands without a password."
    echo "You can now proceed with KubeEZ installation."
else
    echo ""
    echo "❌ Failed to configure passwordless sudo"
    echo "Please check the sudoers configuration manually."
    exit 1
fi
