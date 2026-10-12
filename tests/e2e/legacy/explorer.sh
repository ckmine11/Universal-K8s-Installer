#!/bin/bash
# KubeEZ - Install the KubeEZ Explorer (Radar, Apache-2.0, by Skyhook)
#
# A full Kubernetes UI inside KubeEZ: resources + YAML + logs, topology,
# timeline, Helm, GitOps, cluster audit and upgrade impact.
#
# How it is wired — no open ports, no second login:
#   - Radar runs in namespace kubeez-explorer behind a ClusterIP Service only
#   - KubeEZ is its authentication proxy (auth.mode=proxy): every request comes
#     through KubeEZ's tunnel (SSH / Gateway Agent) carrying the signed-in
#     user as X-Forwarded-User/-Groups; Radar acts as that user (impersonation)
#   - KubeEZ roles map to Kubernetes RBAC through the groups below:
#       kubeez:admins    → cluster-admin
#       kubeez:operators → edit (+ read cluster-wide objects such as nodes)
#       kubeez:viewers   → view (+ the same cluster-wide reads)
#   - Served under /api/clusters/<id>/explorer (KubeEZ writes the id to
#     /etc/kubeez/explorer.env right before this script runs)
#   - Everything is named kubeez-explorer (release, Deployment, Service,
#     ServiceAccount); installs from before the rename (release "radar") are
#     migrated on the next run (Repair)
#
# Idempotent: re-running (Repair) upgrades/repairs in place.
# Failures end with KUBEEZ_FAIL|CODE|reason|fix.

set -o pipefail
KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin

RADAR_CHART_VERSION=${RADAR_CHART_VERSION:-1.15.0}
HELM_VERSION=${HELM_VERSION:-v4.3.0}
NS=kubeez-explorer
CFG=/etc/kubeez/explorer.env

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "KUBEEZ_FAIL|$1|$(printf '%s' "$2" | tr '|\n' '/ ')|$(printf '%s' "$3" | tr '|\n' '/ ')"; exit 1; }
progress() { echo "KUBEEZ_PROGRESS|$1|$2"; }

echo "========================================="
echo "Installing the KubeEZ Explorer"
echo "========================================="

BASE_PATH=""
[ -f "$CFG" ] && BASE_PATH=$(sed -n 's/^KZ_BASE_PATH=//p' "$CFG" | head -1)
[[ "$BASE_PATH" =~ ^/api/clusters/[A-Za-z0-9-]+/explorer$ ]] \
    || fail NOT_CONFIGURED "KubeEZ did not hand over the Explorer address for this cluster." "Install the Explorer from the cluster page in KubeEZ (Add-ons)."

# ── 1. Helm ──────────────────────────────────────────────────────────────────
progress 10 "Preparing Helm"
if ! command -v helm >/dev/null 2>&1; then
    log "Installing Helm ${HELM_VERSION}..."
    A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64
    T=$(mktemp -d)
    curl -fsSL --retry 3 -m 300 "https://get.helm.sh/helm-${HELM_VERSION}-linux-${A}.tar.gz" -o "$T/helm.tgz" \
        || fail NO_INTERNET "Could not download Helm from get.helm.sh." "Allow this control-plane to reach get.helm.sh, then retry."
    tar xzf "$T/helm.tgz" -C "$T" && install -m0755 "$T/linux-${A}/helm" /usr/local/bin/helm \
        || fail NO_INTERNET "The Helm download was damaged." "Retry the install."
    rm -rf "$T"
fi
log "✓ $(helm version --short 2>/dev/null)"

# ── 2. Role mapping (KubeEZ roles → Kubernetes RBAC) ─────────────────────────
progress 25 "Mapping KubeEZ roles to Kubernetes RBAC"
cat <<'EOF' | kubectl apply -f - >/dev/null || fail RBAC_FAILED "Could not create the role mapping." "Check 'kubectl auth can-i create clusterrolebindings' for the admin kubeconfig."
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeez-explorer-cluster-read
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
rules:
  - apiGroups: [""]
    resources: ["nodes", "namespaces", "persistentvolumes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "csidrivers", "csinodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apiextensions.k8s.io"]
    resources: ["customresourcedefinitions"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingressclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["nodes", "pods"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-admins
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: Group, name: "kubeez:admins", apiGroup: rbac.authorization.k8s.io }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-operators
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: edit }
subjects: [{ kind: Group, name: "kubeez:operators", apiGroup: rbac.authorization.k8s.io }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-viewers
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: Group, name: "kubeez:viewers", apiGroup: rbac.authorization.k8s.io }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-cluster-read
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kubeez-explorer-cluster-read }
subjects:
  - { kind: Group, name: "kubeez:operators", apiGroup: rbac.authorization.k8s.io }
  - { kind: Group, name: "kubeez:viewers", apiGroup: rbac.authorization.k8s.io }
EOF
log "✓ Roles mapped (admins → cluster-admin, operators → edit, viewers → view)"

# ── 3. Explorer engine (Radar chart) ─────────────────────────────────────────────────────────────────
# Installs from before the rename used release/resources "radar" — replace them
if helm -n "$NS" status radar >/dev/null 2>&1; then
    log "Moving the Explorer to its new resource names..."
    helm -n "$NS" uninstall radar --wait --timeout 3m >/dev/null 2>&1 || true
fi
progress 40 "Installing the Explorer"
VALUES=$(mktemp)
cat > "$VALUES" <<EOF
fullnameOverride: kubeez-explorer
basePath: "${BASE_PATH}"
service:
  type: ClusterIP
  port: 9280
auth:
  mode: proxy
mcp:
  enabled: false
usageReporting:
  enabled: false
resources:
  requests: { cpu: 100m, memory: 192Mi }
  limits: { cpu: "1", memory: 768Mi }
EOF
helm repo add skyhook https://skyhook-io.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update skyhook >/dev/null 2>&1 \
    || fail NO_INTERNET "Could not reach the Explorer's Helm repository (skyhook-io.github.io)." "Allow this control-plane to reach skyhook-io.github.io and ghcr.io, then retry."
OUT=$(helm upgrade --install kubeez-explorer skyhook/radar --version "$RADAR_CHART_VERSION" \
    --namespace "$NS" --create-namespace -f "$VALUES" --wait --timeout 10m 2>&1)
RC=$?
rm -f "$VALUES"
echo "$OUT" | tail -4 | sed 's/^/  /'
if [ $RC -ne 0 ]; then
    kubectl -n "$NS" get pods 2>/dev/null | sed 's/^/  /'
    fail INSTALL_FAILED "The Explorer did not start: $(echo "$OUT" | tail -1)" \
        "Check 'kubectl -n $NS describe pod -l app.kubernetes.io/instance=kubeez-explorer' (image pull from ghcr.io? memory?), then Repair."
fi

# Helm installs from the Explorer (charts, traffic sources like Caretta):
# Radar 1.15 opens its Helm-write gate only if ITS service account may create
# Secrets (where Helm stores releases). The install itself then runs AS THE
# SIGNED-IN USER (impersonation), so Kubernetes RBAC still decides what each
# KubeEZ role may install. This is the smallest grant that opens the gate —
# NOT the chart's rbac.helm, which would give Radar write access to everything.
cat <<'EOF' | kubectl apply -f - >/dev/null || log "⚠ Could not grant the Helm gate — Helm installs from the Explorer will be refused"
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeez-explorer-helm-gate
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-helm-gate
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kubeez-explorer-helm-gate }
subjects: [{ kind: ServiceAccount, name: kubeez-explorer, namespace: kubeez-explorer }]
EOF

progress 85 "Checking the Explorer"
IP=$(kubectl -n "$NS" get svc kubeez-explorer -o jsonpath='{.spec.clusterIP}' 2>/dev/null)
[ -n "$IP" ] || fail INSTALL_FAILED "The Explorer's Service was not created." "Repair the add-on."
CODE=""
for _ in $(seq 1 24); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://$IP:9280${BASE_PATH}/api/health" 2>/dev/null)
    [ "$CODE" = "200" ] && break
    sleep 5
done
[ "$CODE" = "200" ] || fail NOT_READY "The Explorer runs but does not answer on ${IP}:9280 (HTTP ${CODE:-none})." "Check 'kubectl -n $NS logs deploy/kubeez-explorer', then Repair."
rm -f "$CFG"

progress 100 "KubeEZ Explorer ready"
echo "✓ KubeEZ Explorer installed — open it from the cluster page (Explorer tab)"
echo "========================================="
