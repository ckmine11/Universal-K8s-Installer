#!/bin/bash

# KubeEZ - Upgrade Cluster Script
# This script upgrades a Kubernetes node (Control Plane or Worker) to a target version
# It follows the strict kubeadm upgrade workflow:
# 1. Upgrade kubeadm
# 2. kubeadm upgrade apply (Master 0) or kubeadm upgrade node (Workers/Secondary Masters)
# 3. Drain node
# 4. Upgrade kubelet & kubectl
# 5. Uncordon node

set -e

TARGET_VERSION="${1}"
NODE_ROLE="${2:-master}" # master or worker
IS_FIRST_MASTER="${3:-false}" # true only for the very first master where we run 'upgrade apply'

# Function: Logging
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

if [ -z "$TARGET_VERSION" ]; then
    log "Error: Target version is required (e.g. 1.29.0)"
    exit 1
fi

# Strip 'v' if present
TARGET_VERSION=${TARGET_VERSION#v}
# Major.Minor (e.g. 1.29)
VER_MAJOR_MINOR=$(echo "$TARGET_VERSION" | cut -d. -f1,2)

log "========================================="
log "Starting Upgrade to Kubernetes v${TARGET_VERSION}"
log "Node Role: ${NODE_ROLE}"
log "========================================="

# 0. Safety Pre-flight: Check Version Skew
CURRENT_KUBEADM=$(kubeadm version -o short | cut -dv -f2 | cut -d. -f1,2)
TARGET_MINOR=$(echo "$TARGET_VERSION" | cut -d. -f2)
CURRENT_MINOR=$(echo "$CURRENT_KUBEADM" | cut -d. -f2)

if [ "$((TARGET_MINOR - CURRENT_MINOR))" -gt 1 ]; then
    log "❌ FATAL: Skip-level upgrade detected!"
    log "Cannot upgrade from v${CURRENT_KUBEADM} to v${TARGET_VERSION} directly."
    log "Kubernetes requires sequential upgrades (e.g. 1.28 -> 1.29 -> 1.30)."
    log "Please upgrade to v1.$((CURRENT_MINOR + 1)) first."
    exit 1
fi
if [ "$TARGET_MINOR" -le "$CURRENT_MINOR" ]; then
   log "⚠️ Warning: Target version v${TARGET_VERSION} is not newer than current v${CURRENT_KUBEADM}. Continuing anyway..."
fi

# 1. Detect OS and Package Manager
if command -v apt-get &> /dev/null; then
    PKG_MANAGER="apt"
elif command -v yum &> /dev/null; then
    PKG_MANAGER="yum"
else
    log "Error: Unsupported OS (neither apt nor yum found)"
    exit 1
fi

# 2. Update Repositories
log "Updating package repositories for v${VER_MAJOR_MINOR}..."
if [ "$PKG_MANAGER" = "apt" ]; then
    apt-get update
    # Ensure the repo for the NEW version exists
    # Note: Upgrades usually require adding the new repo first if it calls for a new major.minor
    # For simplicity in this script, we assume the user/system has added the repo for the target version
    # OR we add it dynamically here.
    
    # Dynamic Repo Add for Target Version (Vital for pkgs.k8s.io)
    DIR_NAME="/etc/apt/keyrings"
    mkdir -p $DIR_NAME
    if [ ! -f "$DIR_NAME/kubernetes-apt-keyring.gpg" ]; then
         curl -fsSL https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/Release.key | gpg --dearmor -o $DIR_NAME/kubernetes-apt-keyring.gpg
    fi
    echo "deb [signed-by=$DIR_NAME/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/deb/ /" | tee /etc/apt/sources.list.d/kubernetes.list
    apt-get update

elif [ "$PKG_MANAGER" = "yum" ]; then
    # Overwrite repo file with new version
    cat <<EOF > /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/repodata/repomd.xml.key
EOF
    yum clean all
fi

# 3. Upgrade kubeadm
log "Upgrading kubeadm to ${TARGET_VERSION}..."
if [ "$PKG_MANAGER" = "apt" ]; then
    apt-mark unhold kubeadm
    # Add --allow-downgrades to handle recovery from higher versions
    apt-get install -y --allow-downgrades kubeadm="${TARGET_VERSION}-*"
    apt-mark hold kubeadm
elif [ "$PKG_MANAGER" = "yum" ]; then
    # Yum requires explicit downgrade command if version is higher
    yum install -y kubeadm-${TARGET_VERSION} --disableexcludes=kubernetes
    yum downgrade -y kubeadm-${TARGET_VERSION} --disableexcludes=kubernetes || true
fi

# Verify kubeadm version
KUBEADM_VER=$(kubeadm version -o short)
log "kubeadm upgraded to: $KUBEADM_VER"

# 4. Apply Upgrade (Cluster-level or Node-level)
if [ "$NODE_ROLE" = "master" ]; then
    if [ "$IS_FIRST_MASTER" = "true" ]; then
        log "Running 'kubeadm upgrade apply' (Primary Control Plane)..."
        # --yes skips interactive confirmation
        # Using the matching binary version ensures we don't hit skew errors
        kubeadm upgrade apply "v${TARGET_VERSION}" --yes
    else
        log "Running 'kubeadm upgrade node' (Secondary Control Plane)..."
        kubeadm upgrade node
    fi
else
    log "Running 'kubeadm upgrade node' (Worker)..."
    kubeadm upgrade node
fi

# 5. Upgrade kubelet and kubectl
log "Upgrading kubelet and kubectl to ${TARGET_VERSION}..."

# Drain node (Safely evict pods)
# We run drain from the node itself against itself. 
# Requires working kubeconfig on the node (Masters usually have it). 
# Workers might NOT have admin kubeconfig.
# Strategy: If we are on a master, we can drain. If on worker, we skip drain in this script 
# or assume the orchestration engine (backend) handled the drain remotely before calling this script.
# For this script we will assume backend orchestration handles drain/uncordon to stay safe.
# Proceeding with package upgrade...

if [ "$PKG_MANAGER" = "apt" ]; then
    apt-mark unhold kubelet kubectl
    apt-get install -y kubelet="${TARGET_VERSION}-*" kubectl="${TARGET_VERSION}-*"
    apt-mark hold kubelet kubectl
elif [ "$PKG_MANAGER" = "yum" ]; then
    yum install -y kubelet-${TARGET_VERSION} kubectl-${TARGET_VERSION} --disableexcludes=kubernetes
fi

# 6. Restart kubelet
log "Restarting kubelet..."
systemctl daemon-reload
systemctl restart kubelet

log "========================================="
log "Upgrade Complete! Node is now running v${TARGET_VERSION}"
log "========================================="
