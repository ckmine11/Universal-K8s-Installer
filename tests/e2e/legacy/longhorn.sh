#!/bin/bash
# KubeEZ - Install Longhorn Storage (robust, multi-version, multi-distro)
# Cloud-native distributed block storage for Kubernetes
# Auto-installs open-iscsi + NFS on EVERY node via DaemonSets (Ubuntu/RHEL/CentOS)

set -eo pipefail

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG=$KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/snap/bin

# ─── Robust helpers ─────────────────────────────────────────────────
log() { echo "[$(date +%H:%M:%S)] $*"; }
retry() { local m=$1; shift; local n=1; until "$@"; do [ $n -ge $m ] && { log "FAILED after $m attempts: $*"; return 1; }; log "attempt $n/$m failed, retrying in $((n*5))s..."; sleep $((n*5)); n=$((n+1)); done; }
kapply() { retry 5 kubectl apply "$@"; }
k8s_minor() { kubectl version -o json 2>/dev/null | grep -oE '"minor"[: ]+"?[0-9]+' | grep -oE '[0-9]+' | head -1; }
wait_rollout() { retry 3 kubectl rollout status "$1" -n "$2" --timeout="${3:-600s}"; }

echo "========================================="
echo "Installing Longhorn Storage"
echo "========================================="

# ─── Version selection by k8s minor ─────────────────────────────────
MINOR=$(k8s_minor || echo "")
log "Detected Kubernetes minor version: 1.${MINOR:-unknown}"
# Longhorn v1.7.x supports k8s 1.25–1.31; v1.5.x for older
if [ -n "$MINOR" ] && [ "$MINOR" -ge 25 ] 2>/dev/null; then
    LH_VERSION="v1.7.2"
else
    LH_VERSION="v1.5.3"
fi
log "Using Longhorn $LH_VERSION"

BASE="https://raw.githubusercontent.com/longhorn/longhorn/${LH_VERSION}"

# 1. Namespace
log "Step 1/6: Creating namespace..."
kubectl create namespace longhorn-system --dry-run=client -o yaml | kapply -f -

# 2. Install prerequisites on EVERY node via DaemonSets (cross-distro).
#    These official installers detect apt/yum/dnf and install the right packages
#    (open-iscsi on Ubuntu/Debian, iscsi-initiator-utils on RHEL/CentOS/Rocky).
log "Step 2/6: Installing iSCSI on all nodes (Ubuntu/RHEL/CentOS auto-detected)..."
kapply -f "${BASE}/deploy/prerequisite/longhorn-iscsi-installation.yaml" || log "iSCSI installer manifest not applied (may be unavailable for this version)"

log "Step 3/6: Installing NFSv4 client on all nodes..."
kapply -f "${BASE}/deploy/prerequisite/longhorn-nfs-installation.yaml" || log "NFS installer manifest not applied (non-fatal)"

# Give the DaemonSets time to roll out and install packages on every node
log "Waiting 60s for prerequisite DaemonSets to install packages on all nodes..."
kubectl rollout status daemonset/longhorn-iscsi-installation -n longhorn-system --timeout=180s 2>/dev/null || sleep 60

# 3. Environment check (best-effort — warns, doesn't fail)
log "Step 4/6: Running Longhorn environment check..."
kubectl apply -f "${BASE}/scripts/environment_check.sh" >/dev/null 2>&1 || true

# 4. Install Longhorn core
log "Step 5/6: Installing Longhorn core components..."
kapply -f "${BASE}/deploy/longhorn.yaml"

# 5. Wait for Longhorn to be ready (manager daemonset + driver deployer)
log "Step 6/6: Waiting for Longhorn components..."
# longhorn-manager is a DaemonSet — wait for it first (most reliable readiness signal)
retry 3 kubectl rollout status daemonset/longhorn-manager -n longhorn-system --timeout=600s || \
    log "longhorn-manager rollout timed out — continuing to check driver"
wait_rollout deployment/longhorn-driver-deployer longhorn-system 600s || \
    log "driver-deployer not ready yet — Longhorn may still converge"

# 6. Expose UI via NodePort (idempotent)
log "Exposing Longhorn UI on NodePort 30080..."
cat <<EOF | kapply -f -
apiVersion: v1
kind: Service
metadata:
  name: longhorn-frontend-nodeport
  namespace: longhorn-system
spec:
  type: NodePort
  selector:
    app: longhorn-ui
  ports:
  - port: 80
    targetPort: 8000
    nodePort: 30080
    name: http
EOF

# 7. Set Longhorn as default StorageClass — ONLY after it actually exists
log "Setting Longhorn as default StorageClass..."
for i in $(seq 1 24); do
    if kubectl get storageclass longhorn >/dev/null 2>&1; then
        # Remove default flag from any other storageclass to avoid conflicts
        for sc in $(kubectl get storageclass -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
            [ "$sc" != "longhorn" ] && kubectl patch storageclass "$sc" -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' >/dev/null 2>&1 || true
        done
        kubectl patch storageclass longhorn -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' && break
    fi
    log "Waiting for longhorn StorageClass to appear ($i/24)..."
    sleep 5
done

echo "✓ Longhorn ($LH_VERSION) installed successfully"
echo ""
echo "Access UI:  http://<node-ip>:30080"
echo "Verify:     kubectl get pods -n longhorn-system && kubectl get storageclass"
echo "========================================="
echo "Longhorn installation complete!"
echo "========================================="
