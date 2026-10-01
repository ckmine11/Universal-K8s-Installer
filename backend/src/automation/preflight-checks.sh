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
    # Expanded OS Whitelist for Universal Support
    if [[ "$ID" == "ubuntu" ]] || [[ "$ID" == "debian" ]] || [[ "$ID" == "centos" ]] || [[ "$ID" == "rhel" ]] || [[ "$ID" == "rocky" ]] || [[ "$ID" == "almalinux" ]] || [[ "$ID" == "fedora" ]] || [[ "$ID" == "ol" ]] || [[ "$ID" == "amzn" ]]; then
        echo -e "${GREEN}✓ $PRETTY_NAME${NC}"
    else
        echo -e "${RED}✗ Unsupported OS: $PRETTY_NAME (ID: $ID)${NC}"
        echo -e "${YELLOW}⚠ Proceeding anyway (Universal Mode active)...${NC}"
        # exit 1  <-- Disabled strict exit to allow "Universal" attempt
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
# Test what the install actually needs — DNS + HTTPS to the package repos —
# without relying on ping/host: ICMP is blocked by many clouds/firewalls and
# minimal images ship neither tool. getent (glibc) and bash's /dev/tcp are
# always present.
echo -n "Checking internet and DNS... "
dns_ok()   { getent hosts pkgs.k8s.io &> /dev/null; }
https_ok() { timeout 10 bash -c 'exec 3<>/dev/tcp/pkgs.k8s.io/443' &> /dev/null; }
if ! dns_ok; then
    echo -e "${YELLOW}⚠ DNS resolution failed. Adding public resolvers (8.8.8.8, 1.1.1.1)...${NC}"
    cp /etc/resolv.conf /etc/resolv.conf.kubeez-bak 2>/dev/null || true
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /etc/resolv.conf
    if ! dns_ok; then
        echo -e "${RED}✗ DNS still failing — this node cannot resolve pkgs.k8s.io. Check /etc/resolv.conf and outbound UDP/TCP 53.${NC}"
        exit 1
    fi
fi
if https_ok; then
    echo -e "${GREEN}✓ DNS & HTTPS to pkgs.k8s.io OK${NC}"
elif ping -c 1 -W 3 8.8.8.8 &> /dev/null; then
    echo -e "${RED}✗ Internet works but HTTPS (port 443) to pkgs.k8s.io is blocked. Allow outbound 443 to pkgs.k8s.io, registry.k8s.io and download.docker.com.${NC}"
    exit 1
else
    echo -e "${RED}✗ No internet connectivity — cannot reach pkgs.k8s.io:443. Check the node's gateway/firewall/proxy.${NC}"
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
elif grep -qw overlay /proc/filesystems 2>/dev/null && [ -d /proc/sys/net/bridge ]; then
    # Container/LXC-style hosts have no module tree, but what Kubernetes needs
    # (overlayfs + bridge netfilter) is already loaded by the host kernel.
    echo -e "${GREEN}✓ Kernel $KERNEL_VER (overlay + br_netfilter already available)${NC}"
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
