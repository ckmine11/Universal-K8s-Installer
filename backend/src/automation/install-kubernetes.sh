#!/bin/bash

# KubeEZ - Install Kubernetes Components
# This script installs kubeadm, kubelet, and kubectl
# Supports: CentOS 7 (EOL), RHEL 8/9, Rocky, AlmaLinux, Ubuntu, Debian

set -e

# ─────────────────────────────────────────────────────────────
# PRE-STEP: Universal OS Repo & DNS Fix
# ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/fix-os-repos.sh" ]; then
    bash "${SCRIPT_DIR}/fix-os-repos.sh"
else
    cat > /etc/resolv.conf <<'DNSEOF'
nameserver 8.8.8.8
nameserver 1.1.1.1
DNSEOF
fi

# Release the yum lock on RHEL/CentOS: PackageKit (background updater) grabs
# /var/run/yum.pid on boot and stalls every yum call for minutes. yum/dnf
# systems ONLY — on Ubuntu/Debian a masked PackageKit makes apt's post-invoke
# hook print "GDBus.Error ... UnitMasked" after every apt/dpkg run.
if command -v systemctl &>/dev/null && ! command -v apt-get &>/dev/null; then
    systemctl stop packagekit 2>/dev/null || true
    systemctl mask packagekit 2>/dev/null || true
    pkill -9 -f PackageKit 2>/dev/null || true
    rm -f /var/run/yum.pid 2>/dev/null || true
fi

K8S_VERSION=${1:-"1.28"}

# ── OS / kernel compatibility gate (BEFORE any change) ────────────────────────
# Kubernetes 1.35+ needs a 5.x kernel + cgroups v2. On old kernels (3.x, e.g.
# CentOS 7) kubelet 1.35 will not run reliably. Stop now with a clear message
# so we never build a half-broken cluster.
KMINOR=$(echo "$K8S_VERSION" | cut -d. -f2)
KMAJOR=$(uname -r | cut -d. -f1)
if [ "${KMAJOR:-0}" -lt 4 ] 2>/dev/null && [ "${KMINOR:-0}" -ge 35 ] 2>/dev/null; then
    echo "=================================================================="
    echo "⛔ Kubernetes v1.${KMINOR} is not supported on this node's kernel ($(uname -r))."
    echo "   v1.35+ requires a 5.x kernel with cgroups v2 (Rocky/Alma 9, Ubuntu 22.04+)."
    echo "   ✅ Highest version supported here (CentOS 7 / RHEL 7): Kubernetes v1.34"
    echo "   Please choose v1.34 or older, or use a newer OS. Nothing was installed."
    echo "=================================================================="
    exit 1
fi

echo "========================================="
echo "Installing Kubernetes Components v${K8S_VERSION}"
echo "========================================="

# 1. Install Mandatory Dependencies (Multi-OS)
echo "Installing core dependencies (socat, conntrack, ipset)..."
if command -v apt-get &> /dev/null; then
    apt-get update -y || true   # non-fatal: a broken 3rd-party repo must not abort
    apt-get install -y socat conntrack ipset curl gnupg jq
elif command -v dnf &> /dev/null; then
    dnf install -y socat conntrack ipset curl jq --setopt=*.skip_if_unavailable=1 || dnf install -y socat conntrack ipset curl jq
elif command -v yum &> /dev/null; then
    yum install -y socat conntrack ipset curl jq --setopt=*.skip_if_unavailable=1 || yum install -y socat conntrack ipset curl jq
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
    apt-get update || true   # non-fatal: unrelated broken repos shouldn't block k8s
    apt-get install -y kubelet kubeadm kubectl cri-tools   # cri-tools = crictl (used for diagnostics + upgrades)
    apt-mark hold kubelet kubeadm kubectl

elif command -v dnf &> /dev/null || command -v yum &> /dev/null; then
    PKG_MGR="yum"
    [ -x "$(command -v dnf)" ] && PKG_MGR="dnf"
    
    echo "Installing Kubernetes on RHEL/CentOS/Rocky/Fedora using $PKG_MGR..."
    
    # NOTE: CentOS 7 EOL repos fully handled by fix-os-repos.sh (called above)
    # Repos already point to vault.centos.org and DNS is configured

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
    # Use timeout; skip_if_unavailable so a broken/EOL OS repo can't block k8s
    # dnf5 (Fedora 41+) dropped --disableexcludes; it takes --setopt=disable_excludes
    NOEXCL="--disableexcludes=kubernetes"
    dnf --version 2>/dev/null | grep -q dnf5 && NOEXCL="--setopt=disable_excludes=kubernetes"
    $PKG_MGR install -y kubelet kubeadm kubectl cri-tools $NOEXCL --setopt=timeout=30 --setopt=minrate=100 --setopt=*.skip_if_unavailable=1
    systemctl enable --now kubelet
fi

# Sync containerd's pause (sandbox) image to what THIS kubeadm version expects.
# Since we no longer pass --pod-infra-container-image to kubelet, containerd's
# sandbox_image is the single source of truth for the pause image — it must
# match the k8s version (e.g. 1.35 → pause:3.10) or pods fail to get a sandbox.
if command -v kubeadm >/dev/null 2>&1 && [ -f /etc/containerd/config.toml ]; then
    PAUSE_IMG=$(kubeadm config images list 2>/dev/null | grep -m1 '/pause:')
    if [ -n "$PAUSE_IMG" ]; then
        echo "Setting containerd sandbox_image → $PAUSE_IMG"
        sed -i "s#sandbox_image = .*#sandbox_image = \"$PAUSE_IMG\"#" /etc/containerd/config.toml
        systemctl restart containerd 2>/dev/null || true
        sleep 2
    fi
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
    mkdir -p /etc/modules-load.d
    cat <<EOF > /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
    # Built-in modules (or LXC-style hosts without a module tree) make modprobe
    # fail even though the feature is present — only stop if it's really missing.
    modprobe overlay 2>/dev/null || grep -qw overlay /proc/filesystems || { echo "❌ Kernel feature 'overlay' is not available on this node."; exit 1; }
    modprobe br_netfilter 2>/dev/null || [ -d /proc/sys/net/bridge ] || { echo "❌ Kernel feature 'br_netfilter' is not available on this node."; exit 1; }

    # 3. Apply Sysctl Params (Persistence)
    mkdir -p /etc/sysctl.d
    cat <<EOF > /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
    sysctl --system

    # 4. Configure Kubelet (Production Mode)
    # Removed --fail-swap-on=false because we strictly disabled swap above.
    # IMPORTANT: do NOT set --pod-infra-container-image here. That flag was
    # REMOVED in Kubernetes 1.35 and makes the kubelet crash-loop with
    # "unknown flag: --pod-infra-container-image" → node NotReady. The pause
    # (sandbox) image is set on containerd's sandbox_image instead, which works
    # for every version.
    echo "Configuring kubelet for stability..."
    K_ARGS="--cgroup-driver=systemd --container-runtime-endpoint=unix:///var/run/containerd/containerd.sock"

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
