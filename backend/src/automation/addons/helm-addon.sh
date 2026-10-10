#!/bin/bash
# KubeEZ - install or change a Helm add-on (Metrics Server, MetalLB, Loki,
# Sealed Secrets, Kyverno …) on the primary control-plane.
#
# Usage: helm-addon.sh <key>
# KubeEZ writes the plan right before this runs, to /etc/kubeez/addons/<key>/:
#   releases            one line per Helm release: name|repoName|repoUrl|chart|version
#   namespace           the add-on's namespace
#   <release>.values.yaml   final values (form + advanced YAML + KubeEZ's locked keys)
#   pre.sh  (optional)  checks before anything changes (e.g. "is this IP range free?")
#   post.yaml (optional) objects applied after Helm (address pools, policies)
#   post.sh (optional)  steps after that (Grafana data source, kubeseal …)
#
# helm upgrade --install --rollback-on-failure (Helm 3: --atomic): a failed install or change is rolled back by
# Helm to the version that worked before. Idempotent — Repair runs it again.
# Failures end with KUBEEZ_FAIL|CODE|reason|fix.

set -o pipefail
KEY="${1:-}"
export KUBECONFIG=/etc/kubernetes/admin.conf
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin
HELM_VERSION=${HELM_VERSION:-v4.3.0}
DIR="/etc/kubeez/addons/$KEY"

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "KUBEEZ_FAIL|$1|$(printf '%s' "$2" | tr '|\n' '/ ')|$(printf '%s' "$3" | tr '|\n' '/ ')"; exit 1; }
progress() { echo "KUBEEZ_PROGRESS|$1|$2"; }

[[ "$KEY" =~ ^[a-z0-9-]+$ ]] || fail BAD_INPUT "No add-on name given." "Start the install from the cluster page in KubeEZ."
[ -f "$DIR/releases" ] && [ -f "$DIR/namespace" ] \
    || fail NOT_CONFIGURED "KubeEZ did not hand over the settings for $KEY." "Install or apply the settings from the cluster page in KubeEZ (Add-ons)."
NS=$(head -1 "$DIR/namespace")
[[ "$NS" =~ ^[a-z0-9-]+$ ]] || fail BAD_INPUT "Invalid namespace in the settings." "Apply the settings again from KubeEZ."

echo "========================================="
echo "Add-on: $KEY (namespace $NS)"
echo "========================================="

kubectl get --raw=/readyz >/dev/null 2>&1 \
    || fail API_SERVER_DOWN "The Kubernetes API server is not answering, so nothing was changed." "Check the control plane ('kubectl get nodes' on the master), then try again."

# ── 1. Helm ──────────────────────────────────────────────────────────────────
progress 5 "Preparing Helm"
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
# Helm 4 renamed --atomic (a Helm 3 already on the node keeps working)
ROLLBACK="--rollback-on-failure"
helm version --short 2>/dev/null | grep -q '^v3\.' && ROLLBACK="--atomic"

# ── 2. Checks before changing anything ───────────────────────────────────────
if [ -f "$DIR/pre.sh" ]; then
    progress 10 "Checking the settings"
    # shellcheck disable=SC1091
    . "$DIR/pre.sh"
    log "✓ Settings checked"
fi

# ── 3. Helm releases ─────────────────────────────────────────────────────────
TOTAL=$(grep -c . "$DIR/releases")
I=0
while IFS='|' read -r NAME REPO URL CHART VERSION; do
    [ -n "$NAME" ] || continue
    I=$((I + 1))
    [[ "$NAME$REPO$CHART" =~ ^[a-z0-9-]+$ ]] && [[ "$VERSION" =~ ^[0-9][0-9A-Za-z.+-]*$ ]] && [[ "$URL" =~ ^https://[A-Za-z0-9./_-]+$ ]] \
        || fail BAD_INPUT "Invalid release line in the settings." "Apply the settings again from KubeEZ."
    progress $((15 + 60 * (I - 1) / TOTAL)) "Installing $NAME $VERSION"
    helm repo add "$REPO" "$URL" --force-update >/dev/null 2>&1 \
        || fail NO_INTERNET "Could not reach the Helm repository $URL." "Allow this control-plane to reach $(echo "$URL" | cut -d/ -f3) (and the image registries), then retry."
    PREV=$(helm -n "$NS" history "$NAME" --max 1 -o json 2>/dev/null | grep -o '"revision":[0-9]*' | tail -1 | cut -d: -f2)
    log "${PREV:+Changing}${PREV:-Installing} $NAME (chart $CHART $VERSION)..."
    OUT=$(helm upgrade --install "$NAME" "$REPO/$CHART" --version "$VERSION" --namespace "$NS" --create-namespace \
        -f "$DIR/$NAME.values.yaml" $ROLLBACK --wait --timeout 10m 2>&1)
    RC=$?
    echo "$OUT" | grep -v '^\s*$' | tail -4 | sed 's/^/  /'
    if [ $RC -ne 0 ]; then
        kubectl -n "$NS" get pods 2>/dev/null | sed 's/^/  /'
        WHY=$(echo "$OUT" | grep -iE 'error|failed' | tail -1)
        if [ -n "$PREV" ]; then
            fail INSTALL_FAILED "$NAME did not become ready with the new settings — Helm put back the version that worked (revision $PREV). ${WHY}" \
                "Check the add-on's Logs, fix the setting and apply again. Nothing else changed."
        fi
        fail INSTALL_FAILED "$NAME did not become ready and was removed again. ${WHY}" \
            "Check 'kubectl -n $NS get events --sort-by=.lastTimestamp' (image pull? storage? memory?), then install again."
    fi
    log "✓ $NAME ready"
done < "$DIR/releases"

# ── 4. Objects that need the add-on running (CRDs, webhooks) ─────────────────
if [ -f "$DIR/post.yaml" ]; then
    progress 80 "Applying the configuration"
    OK=""
    for i in $(seq 1 18); do      # webhooks need a moment after the rollout
        if OUT=$(kubectl apply -f "$DIR/post.yaml" 2>&1); then OK=1; break; fi
        sleep 10
    done
    echo "$OUT" | sed 's/^/  /'
    [ -n "$OK" ] || fail CONFIG_FAILED "The add-on runs, but its configuration was refused: $(echo "$OUT" | tail -1)" \
        "Check the settings (e.g. the IP range), then apply again."
fi
if [ -f "$DIR/post.sh" ]; then
    progress 90 "Finishing"
    # shellcheck disable=SC1091
    . "$DIR/post.sh"
fi

rm -rf "$DIR"
progress 100 "$KEY ready"
echo "✓ $KEY installed and configured"
echo "========================================="
