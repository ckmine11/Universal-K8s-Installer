#!/bin/bash

# KubeEZ - Configure Firewall Script
# This script opens the required ports for Kubernetes based on node type
# Supports: CentOS 7 (EOL), CentOS 8/9, RHEL, Rocky, AlmaLinux, Ubuntu, Debian

set -e

# ─────────────────────────────────────────────────────────────
# PRE-STEP: Run Universal OS Repo & DNS fixer FIRST
# This fixes CentOS 7 EOL repos, DNS, IPv6, SSL issues on any OS
# ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/fix-os-repos.sh" ]; then
    echo "Running Universal OS repo/DNS pre-flight fixer..."
    bash "${SCRIPT_DIR}/fix-os-repos.sh"
else
    # Inline minimal DNS fix as fallback
    cat > /etc/resolv.conf <<'DNSEOF'
nameserver 8.8.8.8
nameserver 1.1.1.1
DNSEOF
fi

NODE_TYPE=$1 # 'master' or 'worker'

echo "========================================="
echo "Configuring Firewall for $NODE_TYPE node"
echo "========================================="

# Detect OS
. /etc/os-release

# Aggressive Cleanup (Only for Fresh Installs)
if [ -f /etc/kubernetes/kubelet.conf ] && systemctl is-active --quiet kubelet; then
    echo "This node is already active in a cluster. Skipping destructive network cleanup..."
else
    echo "Cleaning up networking residue..."
    systemctl stop firewalld >/dev/null 2>&1 || true
    systemctl stop ufw >/dev/null 2>&1 || true
    ip link delete cni0 >/dev/null 2>&1 || true
    ip link delete flannel.1 >/dev/null 2>&1 || true
    rm -rf /etc/cni/net.d/* /var/lib/cni/* >/dev/null 2>&1 || true
    iptables -F && iptables -t nat -F && iptables -t mangle -F && iptables -X >/dev/null 2>&1 || true
fi

# NOTE: OS repo/DNS fixes are handled by fix-os-repos.sh (called above)
# No inline CentOS 7 patching needed here anymore

# Detect OS and Install deps
if command -v apt-get &> /dev/null; then
    apt-get update && apt-get install -y psmisc conntrack socat ipset chrony
elif command -v yum &> /dev/null; then
    echo "Installing dependencies via YUM..."
    yum install -y psmisc conntrack-tools socat ipset chrony
fi

# Kernel params for any OS
cat <<EOF > /etc/sysctl.d/k8s-firewall.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
net.ipv4.conf.all.rp_filter         = 0
net.ipv4.conf.default.rp_filter      = 0
net.ipv6.conf.all.disable_ipv6       = 1
EOF
sysctl --system
# Load necessary kernel modules
# We use || true because modprobe might fail in virtualized environments or 
# on some CentOS kernels where the module is already built-in or restricted.
modprobe overlay || echo "Warning: 'overlay' module could not be loaded. containerd might experience issues if it's not built-in."
modprobe br_netfilter || echo "Warning: 'br_netfilter' module could not be loaded. K8s networking will fail if not built-in."

# Smart Firewall Handling
if systemctl is-active --quiet firewalld; then
    echo "Configuring firewalld..."
    if [ "$NODE_TYPE" == "master" ]; then
        for p in 6443 2379-2380 10250 10259 10257 179 5473; do firewall-cmd --permanent --add-port=$p/tcp; done
        firewall-cmd --permanent --add-port=4789/udp
    else
        firewall-cmd --permanent --add-port=10250/tcp
        firewall-cmd --permanent --add-port=30000-32767/tcp
    fi
    firewall-cmd --reload

elif command -v ufw &> /dev/null && ufw status | grep -q "active"; then
    echo "Configuring UFW..."
    if [ "$NODE_TYPE" == "master" ]; then
        ufw allow 6443/tcp && ufw allow 2379:2380/tcp && ufw allow 10250/tcp
    else
        ufw allow 10250/tcp && ufw allow 30000:32767/tcp
    fi
else
    echo "No active firewall (firewalld/ufw) detected. Ensuring iptables is open."
    iptables -P FORWARD ACCEPT
fi

echo "========================================="
echo "Firewall configuration complete!"
echo "========================================="
