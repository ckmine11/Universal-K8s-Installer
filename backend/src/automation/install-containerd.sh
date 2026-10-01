#!/bin/bash

# KubeEZ - Install Container Runtime (containerd)
# This script installs and configures containerd as the container runtime
# Supports: Ubuntu, Debian, CentOS 7 (EOL), RHEL/Rocky/AlmaLinux/Oracle 8-9, Fedora, Amazon Linux

set -e

# ─────────────────────────────────────────────────────────────
# PRE-STEP: Universal OS Repo & DNS Fix (self-contained)
# NOTE: this script is uploaded standalone to /tmp, so a separate
# fix-os-repos.sh is NOT available here. The repair MUST be inline.
# ─────────────────────────────────────────────────────────────
prepare_os_repos() {
    echo "[repo-prep] Preparing OS repositories (DNS, IPv4, EOL mirrors)..."

    # Reliable public DNS if the node can't resolve
    if ! grep -q '8.8.8.8' /etc/resolv.conf 2>/dev/null; then
        cp /etc/resolv.conf /etc/resolv.conf.kubeez-bak 2>/dev/null || true
        printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\noptions timeout:2 attempts:3\n' > /etc/resolv.conf 2>/dev/null || true
    fi

    if command -v yum &>/dev/null || command -v dnf &>/dev/null; then
        # Force IPv4 (fixes curl#7 on nodes without IPv6)
        grep -q '^ip_resolve' /etc/yum.conf 2>/dev/null || echo 'ip_resolve=4' >> /etc/yum.conf 2>/dev/null || true
        [ -f /etc/dnf/dnf.conf ] && { grep -q '^ip_resolve' /etc/dnf/dnf.conf 2>/dev/null || echo 'ip_resolve=4' >> /etc/dnf/dnf.conf 2>/dev/null || true; }

        # CentOS 7 EOL → repoint base repos to the vault archive
        . /etc/os-release 2>/dev/null || true
        if [ "${ID:-}" = "centos" ] && [ "$(echo "${VERSION_ID:-0}" | cut -d. -f1)" = "7" ]; then
            echo "[repo-prep] CentOS 7 (EOL) detected — repointing to vault.centos.org"
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
prepare_os_repos || echo "[repo-prep] warning: repo prep encountered an issue (continuing)"

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

# NOTE: CentOS 7 EOL repos and DNS are handled by fix-os-repos.sh (called above)

# Setup modules and sysctl
echo "Setting up kernel modules and sysctl..."
mkdir -p /etc/modules-load.d   # absent on some minimal installs
cat <<EOF | tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
# Load necessary kernel modules
# We use || true because modprobe might fail in virtualized environments or 
# on some CentOS kernels where the module is already built-in or restricted.
modprobe overlay || echo "Warning: 'overlay' module loading failed."
modprobe br_netfilter || echo "Warning: 'br_netfilter' module loading failed."

mkdir -p /etc/sysctl.d
cat <<EOF | tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system

# Install containerd based on the OS. Kept in one function so every distro
# branch can be exercised on its own.
#   Ubuntu (+ Mint/Pop!_OS)   → Docker repo linux/ubuntu  + UBUNTU_CODENAME
#   Debian (+ derivatives)    → Docker repo linux/debian  + VERSION_CODENAME
#   Fedora                    → Docker repo linux/fedora
#   CentOS/RHEL/Rocky/Alma/OL → Docker repo linux/centos
#   Amazon Linux              → distro 'containerd' package (no Docker CE repo)
install_containerd_package() {
    . /etc/os-release
    local arch
    case "$(uname -m)" in
        x86_64) arch=amd64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) arch=$(uname -m) ;;
    esac

    if command -v apt-get &> /dev/null; then
        local distro codename
        if [ "$ID" = "ubuntu" ] || [ -n "${UBUNTU_CODENAME:-}" ]; then
            distro=ubuntu; codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
        else
            distro=debian; codename="${VERSION_CODENAME:-}"
        fi
        echo "Detected ${PRETTY_NAME:-$ID} → Docker repository linux/${distro} (${codename})"
        # Force IPv4 + retries for APT
        mkdir -p /etc/apt/apt.conf.d
        printf 'Acquire::ForceIPv4 "true";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99kubeez-ipv4
        apt-get update || true   # non-fatal: broken 3rd-party repos shouldn't abort
        DEBIAN_FRONTEND=noninteractive apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
        [ -z "$codename" ] && codename=$(lsb_release -cs 2>/dev/null)
        if [ -z "$codename" ]; then
            echo "❌ Could not detect the ${distro} release codename (VERSION_CODENAME missing in /etc/os-release)."
            return 1
        fi
        mkdir -p /etc/apt/keyrings
        curl -4 -fsSL "https://download.docker.com/linux/${distro}/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg || true
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${distro} ${codename} stable" > /etc/apt/sources.list.d/docker.list
        apt-get update || true
        if ! DEBIAN_FRONTEND=noninteractive apt-get install -y containerd.io; then
            echo "❌ containerd.io is not available from download.docker.com for ${distro} '${codename}'."
            echo "   This ${PRETTY_NAME:-OS} release may not be supported by Docker's repository yet."
            return 1
        fi

    elif command -v dnf &> /dev/null || command -v yum &> /dev/null; then
        local pkg_mgr=yum
        command -v dnf &> /dev/null && pkg_mgr=dnf
        echo "Detected ${PRETTY_NAME:-$ID} (using $pkg_mgr)..."

        # Universal SSL/Time Fix for RHEL family
        $pkg_mgr install -y ca-certificates || true
        if command -v update-ca-trust &> /dev/null; then
            update-ca-trust force-enable || true
            update-ca-trust extract || true
        fi
        # Sync time (TLS fails on a badly skewed clock)
        $pkg_mgr install -y ntpdate >/dev/null 2>&1 && { ntpdate -u pool.ntp.org || true; hwclock -w || true; } || true

        if [ "$ID" = "amzn" ]; then
            # Docker CE has no Amazon Linux repo — the distro ships containerd
            if ! $pkg_mgr install -y containerd; then
                echo "❌ Could not install containerd from the Amazon Linux repositories."
                return 1
            fi
        else
            local repo_os=centos
            [ "$ID" = "fedora" ] && repo_os=fedora
            # Download the .repo file directly: works on yum, dnf4 AND dnf5
            # (dnf5 on Fedora 41+ dropped 'config-manager --add-repo').
            if ! curl -4 -fsSL "https://download.docker.com/linux/${repo_os}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo; then
                echo "⚠️ Repo download failed. Retrying with SSL verification disabled (legacy CentOS 7)..."
                curl -4 -fsSLk "https://download.docker.com/linux/${repo_os}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo || true
                sed -i 's/enabled=1/enabled=1\nsslverify=0/' /etc/yum.repos.d/docker-ce.repo 2>/dev/null || true
            fi
            if ! { $pkg_mgr install -y containerd.io --setopt=*.skip_if_unavailable=1 || $pkg_mgr install -y containerd.io; }; then
                echo "❌ containerd.io is not available from download.docker.com/linux/${repo_os} for ${PRETTY_NAME:-this OS}."
                return 1
            fi
        fi

        # Ensure CNI plugins (missing in some RHEL packages) — correct CPU arch
        if [ ! -d "/opt/cni/bin" ] || [ -z "$(ls -A /opt/cni/bin 2>/dev/null)" ]; then
            echo "Installing CNI plugins manually (${arch})..."
            mkdir -p /opt/cni/bin
            curl -4 -fsSL "https://github.com/containernetworking/plugins/releases/download/v1.3.0/cni-plugins-linux-${arch}-v1.3.0.tgz" | tar -C /opt/cni/bin -xz || true
        fi
    else
        echo "❌ Unsupported OS: no apt-get, dnf or yum found."
        return 1
    fi
}

if ! install_containerd_package; then
    echo "❌ Container runtime installation failed — see the message above."
    exit 1
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
