#!/bin/bash

# KubeEZ - Pre-flight Checks Script
# This script validates that the target node meets all requirements for Kubernetes installation

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================="
echo "KubeEZ Pre-flight Checks"
echo "========================================="

# Check 1: OS Compatibility
echo -n "Checking OS compatibility... "
if [ -f /etc/os-release ]; then
    . /etc/os-release
    if [[ "$ID" == "ubuntu" ]] || [[ "$ID" == "centos" ]] || [[ "$ID" == "rhel" ]] || [[ "$ID" == "rocky" ]]; then
        echo -e "${GREEN}✓ $PRETTY_NAME${NC}"
    else
        echo -e "${RED}✗ Unsupported OS: $PRETTY_NAME${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Cannot determine OS${NC}"
    exit 1
fi

# Check 2: CPU Count (minimum 2)
echo -n "Checking CPU count... "
CPU_COUNT=$(nproc)
if [ "$CPU_COUNT" -ge 2 ]; then
    echo -e "${GREEN}✓ $CPU_COUNT CPUs${NC}"
else
    echo -e "${RED}✗ Minimum 2 CPUs required, found $CPU_COUNT${NC}"
    exit 1
fi

# Check 3: Memory (minimum 2GB)
echo -n "Checking memory... "
MEM_GB=$(free -g | awk '/^Mem:/{print $2}')
if [ "$MEM_GB" -ge 2 ]; then
    echo -e "${GREEN}✓ ${MEM_GB}GB RAM${NC}"
else
    echo -e "${RED}✗ Minimum 2GB RAM required, found ${MEM_GB}GB${NC}"
    exit 1
fi

# Check 4: Disk Space (minimum 20GB free)
echo -n "Checking disk space... "
DISK_FREE=$(df -BG / | awk 'NR==2 {print $4}' | sed 's/G//')
if [ "$DISK_FREE" -ge 20 ]; then
    echo -e "${GREEN}✓ ${DISK_FREE}GB free${NC}"
else
    echo -e "${YELLOW}⚠ Low disk space: ${DISK_FREE}GB free (20GB recommended)${NC}"
fi

# Check 5: Swap Status (should be disabled)
echo -n "Checking swap status... "
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
    echo -e "${GREEN}✓ Swap is disabled${NC}"
else
    echo -e "${YELLOW}⚠ Swap is enabled (will be disabled during installation)${NC}"
fi

# Check 6: Network Connectivity & DNS
echo -n "Checking internet and DNS... "
if ping -c 1 8.8.8.8 &> /dev/null; then
    if host google.com &> /dev/null || ping -c 1 vault.centos.org &> /dev/null; then
        echo -e "${GREEN}✓ DNS & Internet accessible${NC}"
    else
        echo -e "${YELLOW}⚠ DNS Resolution failed. Attempting automatic fix...${NC}"
        echo "nameserver 8.8.8.8" >> /etc/resolv.conf
        if ping -c 1 vault.centos.org &> /dev/null; then
             echo -e "${GREEN}✓ DNS Fixed (Nameserver 8.8.8.8 added)${NC}"
        else
             echo -e "${RED}✗ DNS still failing after fix. System cannot resolve mirrors.${NC}"
             exit 1
        fi
    fi
else
    echo -e "${RED}✗ No internet connectivity (Ping 8.8.8.8 failed)${NC}"
    exit 1
fi

# Check 7: Required Ports (for master node)
echo "Checking required ports..."
REQUIRED_PORTS=(6443 2379 2380 10250 10251 10252)
for port in "${REQUIRED_PORTS[@]}"; do
    if ! ss -tuln | grep -q ":$port "; then
        echo -e "${GREEN}✓ Port $port is available${NC}"
    else
        echo -e "${YELLOW}⚠ Port $port is in use${NC}"
    fi
done

# Check 8: SELinux Status (if applicable)
if command -v getenforce &> /dev/null; then
    echo -n "Checking SELinux status... "
    SELINUX_STATUS=$(getenforce)
    if [ "$SELINUX_STATUS" == "Disabled" ] || [ "$SELINUX_STATUS" == "Permissive" ]; then
        echo -e "${GREEN}✓ SELinux is $SELINUX_STATUS${NC}"
    else
        echo -e "${YELLOW}⚠ SELinux is Enforcing (may cause issues)${NC}"
    fi
fi

# Check 9: Firewall Status
echo -n "Checking firewall status... "
if systemctl is-active --quiet firewalld; then
    echo -e "${YELLOW}⚠ Firewalld is active (ports will be opened)${NC}"
elif systemctl is-active --quiet ufw; then
    echo -e "${YELLOW}⚠ UFW is active (ports will be opened)${NC}"
else
    echo -e "${GREEN}✓ No active firewall detected${NC}"
fi

# Check 10: Kernel Version & Module Availability
echo -n "Checking kernel and modules... "
KERNEL_VER=$(uname -r)
if [ -d "/lib/modules/$KERNEL_VER" ]; then
    echo -e "${GREEN}✓ Kernel $KERNEL_VER (Modules found)${NC}"
else
    echo -e "${RED}✗ Kernel modules not found for $KERNEL_VER. Did you update the kernel recently? REBOOT may be required.${NC}"
    exit 1
fi

# Check 11: Container Runtime
echo -n "Checking for existing container runtime... "
if command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠ Docker is installed (may conflict with containerd)${NC}"
elif command -v containerd &> /dev/null; then
    echo -e "${YELLOW}⚠ Containerd already installed${NC}"
else
    echo -e "${GREEN}✓ No container runtime found${NC}"
fi

# Check 12: Cluster Topology (Scale Intelligence)
if command -v kubectl &> /dev/null && [ -f /etc/kubernetes/admin.conf ]; then
    echo "---CLUSTER_INFO_START---"
    export KUBECONFIG=/etc/kubernetes/admin.conf
    # Use standard table output to avoid shell syntax issues with complex custom-columns
    kubectl get nodes --no-headers -o wide | awk '{print $1, $2, $3, $6}' 2>/dev/null || true
    echo "---CLUSTER_INFO_END---"
fi

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}All pre-flight checks passed!${NC}"
echo -e "${GREEN}=========================================${NC}"
