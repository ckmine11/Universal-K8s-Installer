#!/bin/bash

# KubeEZ - Configure Firewall Script
# This script opens the required ports for Kubernetes based on node type
# Supports: CentOS 7 (EOL), CentOS 8/9, RHEL, Rocky, AlmaLinux, Ubuntu, Debian

set -e

# ─────────────────────────────────────────────────────────────
# PRE-STEP: Universal OS Repo & DNS Fix (self-contained)
# This is the FIRST yum/apt operation in the install flow, so the repair
# MUST be inline (the script is uploaded standalone — no fix-os-repos.sh here).
# ─────────────────────────────────────────────────────────────
prepare_os_repos() {
    echo "[repo-prep] Preparing OS repositories (DNS, IPv4, EOL mirrors)..."
    if ! grep -q '8.8.8.8' /etc/resolv.conf 2>/dev/null; then
        cp /etc/resolv.conf /etc/resolv.conf.kubeez-bak 2>/dev/null || true
        printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\noptions timeout:2 attempts:3\n' > /etc/resolv.conf 2>/dev/null || true
    fi
    if command -v yum &>/dev/null || command -v dnf &>/dev/null; then
        grep -q '^ip_resolve' /etc/yum.conf 2>/dev/null || echo 'ip_resolve=4' >> /etc/yum.conf 2>/dev/null || true
        [ -f /etc/dnf/dnf.conf ] && { grep -q '^ip_resolve' /etc/dnf/dnf.conf 2>/dev/null || echo 'ip_resolve=4' >> /etc/dnf/dnf.conf 2>/dev/null || true; }
        . /etc/os-release 2>/dev/null || true
        if [ "${ID:-}" = "centos" ] && [ "$(echo "${VERSION_ID:-0}" | cut -d. -f1)" = "7" ]; then
            echo "[repo-prep] CentOS 7 (EOL) — repointing to vault.centos.org"
            rm -f /etc/yum.repos.d/CentOS-*.repo 2>/dev/null || true
            cat > /etc/yum.repos.d/CentOS-Vault.repo <<'REPOEOF'
[base]
name=CentOS-7 - Base (Vault)
baseurl=http://vault.centos.org/centos/7/os/$basearch/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4

[updates]
name=CentOS-7 - Updates (Vault)
baseurl=http://vault.centos.org/centos/7/updates/$basearch/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4

[extras]
name=CentOS-7 - Extras (Vault)
baseurl=http://vault.centos.org/centos/7/extras/$basearch/
gpgcheck=0
enabled=1
skip_if_unavailable=1
timeout=15
ip_resolve=4
REPOEOF
            yum clean all 2>/dev/null || true
            rm -rf /var/cache/yum/* 2>/dev/null || true
        fi
    fi
    if command -v apt-get &>/dev/null; then
        mkdir -p /etc/apt/apt.conf.d
        printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99kubeez-ipv4 2>/dev/null || true
    fi
}
prepare_os_repos || echo "[repo-prep] warning: continuing despite repo prep issue"

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
    apt-get update || true   # non-fatal: broken 3rd-party repo shouldn't abort
    apt-get install -y psmisc conntrack socat ipset chrony || true
elif command -v yum &> /dev/null; then
    echo "Installing dependencies via YUM..."
    # skip_if_unavailable: broken/EOL OS repos must not block dependency install
    yum install -y psmisc conntrack-tools socat ipset chrony --setopt=*.skip_if_unavailable=1 || \
        yum install -y psmisc conntrack-tools socat ipset chrony || true
fi

# Kernel params for any OS
mkdir -p /etc/sysctl.d   # absent on some minimal installs
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
