#!/bin/bash
# KubeEZ - Install cert-manager (robust, multi-version, multi-distro)
# Automatic TLS certificate management for Kubernetes

set -eo pipefail

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG=$KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/snap/bin

# ─── Robust helpers ─────────────────────────────────────────────────
log() { echo "[$(date +%H:%M:%S)] $*"; }
retry() { local m=$1; shift; local n=1; until "$@"; do [ $n -ge $m ] && { log "FAILED after $m attempts: $*"; return 1; }; log "attempt $n/$m failed, retrying in $((n*5))s..."; sleep $((n*5)); n=$((n+1)); done; }
kapply() { retry 5 kubectl apply "$@"; }
k8s_minor() { kubectl version -o json 2>/dev/null | grep -oE '"minor"[: ]+"?[0-9]+' | grep -oE '[0-9]+' | head -1; }
wait_crd() { local c=$1; for i in $(seq 1 40); do kubectl get crd "$c" >/dev/null 2>&1 && { kubectl wait --for=condition=Established "crd/$c" --timeout=60s >/dev/null 2>&1 && return 0; }; sleep 5; done; return 1; }
wait_rollout() { retry 3 kubectl rollout status "$1" -n "$2" --timeout="${3:-300s}"; }

echo "========================================="
echo "Installing cert-manager"
echo "========================================="

# ─── Version selection by k8s minor (broad compatibility) ───────────
MINOR=$(k8s_minor || echo "")
log "Detected Kubernetes minor version: 1.${MINOR:-unknown}"
# cert-manager v1.16.x supports k8s 1.25–1.31; v1.13.x for older clusters
if [ -n "$MINOR" ] && [ "$MINOR" -ge 25 ] 2>/dev/null; then
    CM_VERSION="v1.16.2"
else
    CM_VERSION="v1.13.3"
fi
log "Using cert-manager $CM_VERSION"

# 1. Namespace (idempotent)
log "Step 1/4: Creating namespace..."
kubectl create namespace cert-manager --dry-run=client -o yaml | kapply -f -

# 2. Install CRDs + controller (retry on network/API errors)
log "Step 2/4: Installing cert-manager manifests..."
kapply -f "https://github.com/cert-manager/cert-manager/releases/download/${CM_VERSION}/cert-manager.yaml"

# 3. Wait for CRDs to be established BEFORE using them
log "Step 3/4: Waiting for CRDs & controllers..."
wait_crd "clusterissuers.cert-manager.io" || { log "cert-manager CRDs not ready"; exit 1; }
wait_rollout deployment/cert-manager cert-manager 300s
wait_rollout deployment/cert-manager-webhook cert-manager 300s
wait_rollout deployment/cert-manager-cainjector cert-manager 300s

# Webhook readiness check — the API can reject ClusterIssuer until the
# webhook endpoint is actually serving. Wait for endpoints, then retry apply.
log "Waiting for webhook to be reachable..."
for i in $(seq 1 30); do
    if kubectl get endpoints cert-manager-webhook -n cert-manager -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null | grep -q .; then
        break
    fi
    sleep 5
done

# 4. Self-signed ClusterIssuer (retry — webhook may still be warming up)
log "Step 4/4: Creating self-signed ClusterIssuer..."
apply_issuer() {
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
EOF
}
retry 6 apply_issuer

echo "✓ cert-manager ($CM_VERSION) installed successfully"
echo ""
echo "Verify: kubectl get pods -n cert-manager && kubectl get clusterissuers"
echo "========================================="
echo "cert-manager installation complete!"
echo "========================================="
