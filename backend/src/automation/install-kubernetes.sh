#!/bin/bash

# KubeEZ - Install Kubernetes Components
# This script installs kubeadm, kubelet, and kubectl

set -e

K8S_VERSION=${1:-"1.28"}

echo "========================================="
echo "Installing Kubernetes Components v${K8S_VERSION}"
echo "========================================="

# 1. Install Mandatory Dependencies (Multi-OS)
echo "Installing core dependencies (socat, conntrack, ipset)..."
if command -v apt-get &> /dev/null; then
    apt-get update -y
    apt-get install -y socat conntrack ipset curl gnupg jq
elif command -v dnf &> /dev/null; then
    dnf install -y socat conntrack ipset curl jq
elif command -v yum &> /dev/null; then
    yum install -y socat conntrack ipset curl jq
else
    echo "Warning: No supported package manager found. High risk of failure."
fi

# Detect OS
. /etc/os-release

# Unified Installation Logic
if command -v apt-get &> /dev/null; then
    echo "Installing Kubernetes on Debian/Ubuntu..."
    # apt-get update is already done by the dependency installation block
    apt-get install -y apt-transport-https ca-certificates # curl and gnupg (gpg) are already installed by the dependency block
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/deb/Release.key | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg || true
    echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/deb/ /" | tee /etc/apt/sources.list.d/kubernetes.list
    apt-get update
    apt-get install -y kubelet kubeadm kubectl
    apt-mark hold kubelet kubeadm kubectl

elif command -v dnf &> /dev/null || command -v yum &> /dev/null; then
    PKG_MGR="yum"
    [ -x "$(command -v dnf)" ] && PKG_MGR="dnf"
    
    echo "Installing Kubernetes on RHEL/CentOS/Rocky/Fedora using $PKG_MGR..."
    
    # CentOS 7 EOL Fix (Triple-protection)
    if [ -f /etc/yum.repos.d/CentOS-Base.repo ] && grep -q "release 7" /etc/redhat-release; then
        echo "Updating CentOS 7 mirrors for Kubernetes repo stability..."
        sed -i 's/mirrorlist/#mirrorlist/g' /etc/yum.repos.d/CentOS-*
        sed -i 's|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*
    fi

    # Disable SELinux (Required for K8s)
    setenforce 0 || true
    sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config || true
    
    cat <<EOF | tee /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v${K8S_VERSION}/rpm/repodata/repomd.xml.key
EOF
    # Use timeout and increase verbosity
    $PKG_MGR install -y kubelet kubeadm kubectl --disableexcludes=kubernetes --setopt=timeout=30 --setopt=minrate=100
    systemctl enable --now kubelet
fi

# Node Stabilization (Skip if already active)
if [ -f /etc/kubernetes/kubelet.conf ] && systemctl is-active --quiet kubelet; then
    echo "Kubelet is already active and configured. Skipping restart..."
else
    # ---------------------------------------------------------
    # Production-Grade System Prep
    # ---------------------------------------------------------

    # 1. Disable swap PERMANENTLY (Critical for Stable K8s)
    echo "Disabling swap permanently..."
    swapoff -a
    if [ -f /etc/fstab ]; then
        sed -i '/swap/s/^/#/' /etc/fstab
    fi

    # 2. Persist Kernel Modules
    echo "Persisting kernel modules..."
    cat <<EOF > /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
    modprobe overlay
    modprobe br_netfilter

    # 3. Apply Sysctl Params (Persistence)
    cat <<EOF > /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
    sysctl --system

    # 4. Configure Kubelet (Production Mode)
    # Removed --fail-swap-on=false because we strictly disabled swap above
    echo "Configuring kubelet for stability..."
    K_ARGS="--cgroup-driver=systemd --container-runtime-endpoint=unix:///var/run/containerd/containerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.9"

    # Handle different config paths
    if [ -d /etc/sysconfig ]; then
        echo "KUBELET_EXTRA_ARGS=\"$K_ARGS\"" > /etc/sysconfig/kubelet
        # Ensure directory exists
        mkdir -p /etc/systemd/system/kubelet.service.d
    fi
    if [ -d /etc/default ]; then
        echo "KUBELET_EXTRA_ARGS=\"$K_ARGS\"" > /etc/default/kubelet
    fi

    # Final Cleanup and Restart
    systemctl daemon-reload
    systemctl enable kubelet
    systemctl restart kubelet
fi

echo "✓ Kubernetes components installed successfully"
kubeadm version
kubectl version --client
