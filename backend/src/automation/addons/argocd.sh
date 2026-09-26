#!/bin/bash
# KubeEZ - Install ArgoCD (robust, multi-version)
# GitOps continuous delivery tool for Kubernetes

set -eo pipefail

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG=$KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/snap/bin

# ─── Robust helpers ─────────────────────────────────────────────────
log() { echo "[$(date +%H:%M:%S)] $*"; }
retry() { local m=$1; shift; local n=1; until "$@"; do [ $n -ge $m ] && { log "FAILED after $m attempts: $*"; return 1; }; log "attempt $n/$m failed, retrying in $((n*5))s..."; sleep $((n*5)); n=$((n+1)); done; }
kapply() { retry 5 kubectl apply "$@"; }
k8s_minor() { kubectl version -o json 2>/dev/null | grep -oE '"minor"[: ]+"?[0-9]+' | grep -oE '[0-9]+' | head -1; }
wait_rollout() { retry 3 kubectl rollout status "$1" -n "$2" --timeout="${3:-300s}"; }

echo "========================================="
echo "Installing ArgoCD"
echo "========================================="

MINOR=$(k8s_minor || echo "")
log "Detected Kubernetes minor version: 1.${MINOR:-unknown}"
# Pin to a stable ArgoCD release for reproducibility; fall back to 'stable' tag
if [ -n "$MINOR" ] && [ "$MINOR" -ge 25 ] 2>/dev/null; then
    ARGO_REF="v2.13.2"
else
    ARGO_REF="v2.9.3"
fi
log "Using ArgoCD $ARGO_REF"

# 1. Namespace
log "Step 1/4: Creating namespace..."
kubectl create namespace argocd --dry-run=client -o yaml | kapply -f -

# 2. Install ArgoCD (server-side apply handles large CRDs; retry on transient errors)
log "Step 2/4: Installing ArgoCD manifests..."
INSTALL_URL="https://raw.githubusercontent.com/argoproj/argo-cd/${ARGO_REF}/manifests/install.yaml"
if ! retry 3 kubectl apply -n argocd --server-side --force-conflicts -f "$INSTALL_URL"; then
    log "Pinned version failed, falling back to 'stable'..."
    kubectl apply -n argocd --server-side --force-conflicts -f "https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml"
fi

# 3. Wait for core components
log "Step 3/4: Waiting for ArgoCD components..."
wait_rollout deployment/argocd-server argocd 300s
wait_rollout deployment/argocd-repo-server argocd 300s
# dex is optional in some versions — don't hard-fail
kubectl rollout status deployment/argocd-dex-server -n argocd --timeout=180s 2>/dev/null || log "dex-server not present/ready (non-fatal)"

# 4. Expose via NodePort (idempotent patch)
log "Step 4/4: Exposing ArgoCD UI on NodePort 30443..."
retry 3 kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort", "ports": [{"port": 443, "targetPort": 8080, "nodePort": 30443, "name": "https"}]}}'

# 5. Retrieve initial admin password (retry — secret is created asynchronously)
log "Retrieving initial admin password..."
INITIAL_PASSWORD=""
for i in $(seq 1 24); do
    INITIAL_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" 2>/dev/null | base64 -d 2>/dev/null || true)
    [ -n "$INITIAL_PASSWORD" ] && break
    sleep 5
done

echo ""
echo "✓ ArgoCD ($ARGO_REF) installed successfully"
echo "========================================="
echo "ArgoCD Access Information"
echo "========================================="
echo "  URL:      https://<node-ip>:30443"
echo "  Username: admin"
if [ -n "$INITIAL_PASSWORD" ]; then
    echo "  Password: $INITIAL_PASSWORD"
else
    echo "  Password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d"
fi
echo ""
echo "Verify: kubectl get pods -n argocd"
echo "========================================="
echo "ArgoCD installation complete!"
echo "========================================="
