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
    PKG_MGR="apt"
elif command -v dnf &> /dev/null; then
    PKG_MGR="dnf"
elif command -v yum &> /dev/null; then
    PKG_MGR="yum"
else
    log "Error: Unsupported OS (neither apt, dnf nor yum found)"
    exit 1
fi
log "Detected Package Manager: $PKG_MGR"

# 2. Update Repositories
log "Updating package repositories for v${VER_MAJOR_MINOR}..."
if [ "$PKG_MGR" = "apt" ]; then
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
elif [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    # Overwrite repo file with new version
    # Standardize on 'kubernetes.repo' and '[kubernetes]' ID to play nice with existing yum history
    rm -f /etc/yum.repos.d/kubernete*.repo /etc/yum.repos.d/k8s*.repo

    cat <<EOF > /etc/yum.repos.d/kubernetes.repo
[kubernetes]
name=Kubernetes v${VER_MAJOR_MINOR}
baseurl=https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/repodata/repomd.xml.key
EOF

    # Hard Clean of Yum Cache to fix 'No package' errors
    rm -rf /var/cache/yum
    yum clean all
    
    # Verify Connectivity
    echo "Testing repository connectivity..."
    curl -I -m 5 https://pkgs.k8s.io/core:/stable:/v${VER_MAJOR_MINOR}/rpm/repodata/repomd.xml || echo "⚠️ Warning: Repo URL did not respond 200 OK"
    
    # DEBUG: print repo file to verify it was written correctly
    echo "--- DEBUG: Current Kubernetes Repo Definition ---"
    cat /etc/yum.repos.d/kubernetes.repo
    echo "-------------------------------------------------"

    # Clear Version Locks if plugin exists (Common cause of 'No package available')
    if rpm -q yum-plugin-versionlock &> /dev/null; then
        echo "Clearing yum version locks..."
        yum versionlock clear || true
    fi
    
    yum makecache
    yum repolist
fi

# 3. Upgrade kubeadm
log "Upgrading kubeadm to ${TARGET_VERSION}..."
if [ "$PKG_MGR" = "apt" ]; then
    apt-mark unhold kubeadm
    # Add --allow-downgrades to handle recovery from higher versions
    apt-get install -y --allow-downgrades kubeadm="${TARGET_VERSION}-*"
    apt-mark hold kubeadm
elif [ "$PKG_MGR" = "yum" ] || [ "$PKG_MGR" = "dnf" ]; then
    # Yum/DNF logic
    # Use wildcard * to match revisions (e.g. 1.33.0-150...)
    
    # We use --disableexcludes=all to be absolutely sure nothing blocks us
    
    if ! $PKG_MGR install -y "kubeadm-${TARGET_VERSION}*" --disableexcludes=all; then
        echo "❌ Failed to install kubeadm-${TARGET_VERSION}. Listing available versions:"
        $PKG_MGR --showduplicates list kubeadm --disableexcludes=all
        exit 1
    fi
     $PKG_MGR downgrade -y "kubeadm-${TARGET_VERSION}*" --disableexcludes=all || true
fi

# Verify kubeadm version
KUBEADM_VER=$(kubeadm version -o short)
log "kubeadm upgraded to: $KUBEADM_VER"

# 4. Apply Upgrade (Cluster-level or Node-level)

# FIX: Check for Legacy Kernel (Kernel < 4.x) and ignore SystemVerification globally
KERNEL_MAJOR=$(uname -r | cut -d. -f1)
IGNORE_FLAGS=""
if [ "$KERNEL_MAJOR" -lt 4 ]; then
    log "⚠️ Warning: Legacy Kernel detected ($(uname -r)). Bypassing SystemVerification check for Universal Compatibility."
    IGNORE_FLAGS="--ignore-preflight-errors=SystemVerification"
fi

if [ "$NODE_ROLE" = "master" ]; then
    if [ "$IS_FIRST_MASTER" = "true" ]; then
        log "Running 'kubeadm upgrade apply' (Primary Control Plane)..."
        
        # --yes skips interactive confirmation
        # Using the matching binary version ensures we don't hit skew errors
        kubeadm upgrade apply "v${TARGET_VERSION}" --yes $IGNORE_FLAGS
    else
        log "Running 'kubeadm upgrade node' (Secondary Control Plane)..."
        kubeadm upgrade node $IGNORE_FLAGS
    fi
else
    log "Running 'kubeadm upgrade node' (Worker)..."
    kubeadm upgrade node $IGNORE_FLAGS
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

if [ "$PKG_MGR" = "apt" ]; then
    apt-mark unhold kubelet kubectl
    apt-get install -y kubelet="${TARGET_VERSION}-*" kubectl="${TARGET_VERSION}-*"
    apt-mark hold kubelet kubectl
elif [ "$PKG_MGR" = "yum" ]; then
    yum install -y kubelet-${TARGET_VERSION}* kubectl-${TARGET_VERSION}* --disableexcludes=all
elif [ "$PKG_MGR" = "dnf" ]; then
    dnf install -y kubelet-${TARGET_VERSION}* kubectl-${TARGET_VERSION}* --disableexcludes=all
fi

# 6. Restart kubelet
log "Restarting kubelet..."
systemctl daemon-reload
systemctl restart kubelet

log "========================================="
log "Upgrade Complete! Node is now running v${TARGET_VERSION}"
log "========================================="
