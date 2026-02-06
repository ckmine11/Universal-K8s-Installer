#!/bin/bash

# KubeEZ - Install Container Runtime (containerd)
# This script installs and configures containerd as the container runtime

set -e

echo "========================================="
echo "Installing Container Runtime (containerd)"
echo "========================================="

# Detect OS
. /etc/os-release
OS_ID=$ID
OS_VERSION=$VERSION_ID

# Disable swap (Critical for all K8s platforms)
echo "Disabling swap..."
swapoff -a
# Comment out swap entries in fstab
if [ -f /etc/fstab ]; then
    sed -i '/swap/s/^/#/' /etc/fstab
fi

# CentOS 7 EOL & DNS Fix (Double-protection)
if [ -f /etc/yum.repos.d/CentOS-Base.repo ] && grep -q "release 7" /etc/redhat-release; then
    echo "Applying CentOS 7 EOL repo patches..."
    # Ensure DNS
    if ! ping -c 1 vault.centos.org &> /dev/null; then
        echo "nameserver 8.8.8.8" >> /etc/resolv.conf
    fi
    sed -i 's/mirrorlist/#mirrorlist/g' /etc/yum.repos.d/CentOS-*
    sed -i 's|#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*
fi

# Setup modules and sysctl
echo "Setting up kernel modules and sysctl..."
cat <<EOF | tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
# Load necessary kernel modules
# We use || true because modprobe might fail in virtualized environments or 
# on some CentOS kernels where the module is already built-in or restricted.
modprobe overlay || echo "Warning: 'overlay' module loading failed."
modprobe br_netfilter || echo "Warning: 'br_netfilter' module loading failed."

cat <<EOF | tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system

# Install containerd based on package manager
if command -v apt-get &> /dev/null; then
    echo "Detected Debian/Ubuntu system..."
    apt-get update
    apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg || true
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update
    apt-get install -y containerd.io

elif command -v dnf &> /dev/null || command -v yum &> /dev/null; then
    PKG_MGR="yum"
    [ -x "$(command -v dnf)" ] && PKG_MGR="dnf"
    
    echo "Detected RHEL/CentOS/Rocky/Fedora system (using $PKG_MGR)..."

    # Universal SSL/Time Fix for RHEL family
    $PKG_MGR install -y ca-certificates || true
    if command -v update-ca-trust &> /dev/null; then
        update-ca-trust force-enable || true
        update-ca-trust extract || true
    fi
    
    # Sync time
    $PKG_MGR install -y ntpdate || true
    ntpdate -u pool.ntp.org || true
    hwclock -w || true

    # Install Utils
    if [ "$PKG_MGR" = "dnf" ]; then
        $PKG_MGR install -y dnf-plugins-core
        $PKG_MGR config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    else
        $PKG_MGR install -y yum-utils
        yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    fi

    # Fallback for Repo SSL issues (Legacy CentOS 7)
    if [ $? -ne 0 ]; then
         echo "⚠️ Repo add failed. Retrying with SSL verification disabled..."
         if [ "$PKG_MGR" = "dnf" ]; then
            $PKG_MGR config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
         else
            yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
         fi
         # Disable SSL verify for this specific repo
         sed -i 's/enabled=1/enabled=1\nsslverify=0/' /etc/yum.repos.d/docker-ce.repo
    fi

    $PKG_MGR install -y containerd.io

    # Ensure CNI plugins (Missing in some RHEL packages)
    if [ ! -d "/opt/cni/bin" ] || [ -z "$(ls -A /opt/cni/bin)" ]; then
        echo "Installing CNI plugins manually for RHEL-based system..."
        mkdir -p /opt/cni/bin
        curl -L https://github.com/containernetworking/plugins/releases/download/v1.3.0/cni-plugins-linux-amd64-v1.3.0.tgz | tar -C /opt/cni/bin -xz
    fi
fi

# Unified Containerd Configuration
echo "Configuring containerd..."
mkdir -p /etc/containerd
cat <<EOF > /etc/containerd/config.toml
version = 2
[plugins]
  [plugins."io.containerd.grpc.v1.cri"]
    sandbox_image = "registry.k8s.io/pause:3.9"
    [plugins."io.containerd.grpc.v1.cri".containerd]
      default_runtime_name = "runc"
      [plugins."io.containerd.grpc.v1.cri".containerd.runtimes]
        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
          runtime_type = "io.containerd.runc.v2"
          [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
            SystemdCgroup = true
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = ""
EOF

# Configure crictl (Vital for kubeadm checks)
echo "Configuring crictl..."
cat <<EOF > /etc/crictl.yaml
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
EOF

# Idempotency Check: Don't break an existing cluster node
if [ -f /etc/kubernetes/kubelet.conf ] && systemctl is-active --quiet containerd; then
    echo "This node is already part of a cluster. Skipping destructive containerd reset..."
else
    # Reset and restart containerd (The "Nuclear" option for fresh installs)
    echo "Performing fresh containerd setup..."
    systemctl daemon-reload
    systemctl stop containerd || true
    rm -rf /var/lib/containerd/io.containerd.metadata.v1.bolt/meta.db || true
    systemctl enable --now containerd
fi

# Verify
if systemctl is-active --quiet containerd; then
    echo "✓ containerd is running"
    rm -f /etc/cni/net.d/10-containerd-net.conflist || true
else
    echo "✗ Failed to start containerd"
    exit 1
fi

echo "========================================="
echo "Container runtime installation complete!"
echo "========================================="
