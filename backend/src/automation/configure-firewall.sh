#!/bin/bash

# KubeEZ - Configure Firewall Script
# This script opens the required ports for Kubernetes based on node type

set -e

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

# DNS & Repo Fix for CentOS 7 EOL
if [ -f /etc/yum.repos.d/CentOS-Base.repo ] && grep -q "release 7" /etc/redhat-release; then
    echo "CentOS 7 detected. Applying EOL repository and DNS fixes..."
    
    # Ensure DNS is working (Add Google DNS as backup)
    if ! ping -c 1 vault.centos.org &> /dev/null; then
        echo "Mirror host not reachable. Adding nameserver 8.8.8.8 to /etc/resolv.conf"
        echo "nameserver 8.8.8.8" >> /etc/resolv.conf
    fi

    # Patch Repos to use Vault
    sed -i 's/mirrorlist/#mirrorlist/g' /etc/yum.repos.d/CentOS-*
    sed -i 's|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*
    
    yum clean all
    yum makecache
fi

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
