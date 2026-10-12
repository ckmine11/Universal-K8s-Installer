#!/bin/bash
# KubeEZ - install or change an add-on with Helm, on the primary control-plane.
#
# Usage: helm-addon.sh <key>
# KubeEZ writes the plan right before this runs, to /etc/kubeez/addons/<key>/:
#   releases            one line per Helm release: name|repo|repoUrl|chart|version|flags
#                       (repo "local" = a chart KubeEZ ships, under charts/<chart>;
#                        flags: local, crds = apply the chart's CRDs first,
#                        norollback = never roll back automatically, e.g. Longhorn,
#                        slow = wait up to 20 minutes instead of 10,
#                        csa = client-side apply on Helm 4 (controllers that patch their own webhooks))
#   namespace           the add-on's namespace
#   <release>.values.yaml   final values (form + advanced YAML + KubeEZ's locked keys)
#   <release>.auto.yaml     (optional, written by pre.sh) values found on the cluster —
#                           e.g. the node ports that run now; the values file wins
#   pre.sh  (optional)  checks before anything changes; may write *.auto.yaml
#   takeover (optional) "<kind>/<name>" of an install made before Helm managed it;
#                       Helm then takes the existing objects over (--take-ownership)
#   migrate.sh (optional) runs once before a takeover (objects Helm cannot adopt)
#   post.yaml (optional) objects applied after Helm (address pools, policies, issuers)
#   post.sh (optional)  steps after that (data sources, CLIs, buckets …)
#
# A failed install or change is rolled back by Helm to what worked before
# (--rollback-on-failure; Helm 3: --atomic). Not during a takeover: a rollback
# there would delete what was taken over. Idempotent — Repair runs it again.
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

# ── 1. Helm (a Helm older than 3.17 on the node is left alone; KubeEZ uses its own) ──
progress 5 "Preparing Helm"
install_helm() {   # <target>
    A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64
    T=$(mktemp -d)
    curl -fsSL --retry 3 -m 300 "https://get.helm.sh/helm-${HELM_VERSION}-linux-${A}.tar.gz" -o "$T/helm.tgz" \
        || fail NO_INTERNET "Could not download Helm from get.helm.sh." "Allow this control-plane to reach get.helm.sh, then retry."
    tar xzf "$T/helm.tgz" -C "$T" && install -D -m0755 "$T/linux-${A}/helm" "$1" \
        || fail NO_INTERNET "The Helm download was damaged." "Retry the install."
    rm -rf "$T"
}
HELM=helm
command -v helm >/dev/null 2>&1 || { log "Installing Helm ${HELM_VERSION}..."; install_helm /usr/local/bin/helm; }
HV=$(helm version --short 2>/dev/null)
if [[ "$HV" =~ ^v3\.([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -lt 17 ]; then
    HELM=/usr/local/lib/kubeez/helm
    [ -x "$HELM" ] || { log "Helm $HV is too old for KubeEZ — using its own Helm ${HELM_VERSION}"; install_helm "$HELM"; }
    HV=$($HELM version --short 2>/dev/null)
fi
log "✓ Helm $HV"
# Helm 4 renamed --atomic
ROLLBACK="--rollback-on-failure"
[[ "$HV" =~ ^v3\. ]] && ROLLBACK="--atomic"

# ── 2. Checks before changing anything ───────────────────────────────────────
if [ -f "$DIR/pre.sh" ]; then
    progress 10 "Checking the settings"
    # shellcheck disable=SC1091
    . "$DIR/pre.sh"
    log "✓ Settings checked"
fi

# ── 3. An install made before KubeEZ managed it with Helm? ───────────────────
# A release that never deployed successfully (e.g. an interrupted takeover)
# still counts as "not taken over yet"
ever_deployed() { $HELM -n "$NS" history "$1" -o json 2>/dev/null | grep -qE '"status":"(deployed|superseded)"'; }

FIRST=$(grep -m1 . "$DIR/releases" | cut -d'|' -f1)
TAKEOVER=""
if [ -f "$DIR/takeover" ] && ! ever_deployed "$FIRST"; then
    REF=$(head -1 "$DIR/takeover")
    REF_RE='^[a-z0-9./ -]+$'
    if [[ "$REF" =~ $REF_RE ]] && kubectl -n "$NS" get $REF >/dev/null 2>&1; then
        TAKEOVER=1
        log "Found $KEY installed before KubeEZ managed it with Helm — taking it over in place"
        if [ -f "$DIR/migrate.sh" ]; then
            progress 12 "Preparing the takeover"
            # shellcheck disable=SC1091
            . "$DIR/migrate.sh"
        fi
    fi
fi

# ── 4. Helm releases ─────────────────────────────────────────────────────────
TOTAL=$(grep -c . "$DIR/releases")
I=0
while IFS='|' read -r NAME REPO URL CHART VERSION FLAGS; do
    [ -n "$NAME" ] || continue
    I=$((I + 1))
    [[ "$NAME$REPO$CHART" =~ ^[a-z0-9-]+$ ]] && [[ "$VERSION" =~ ^v?[0-9][0-9A-Za-z.+-]*$ ]] && [[ "$URL" =~ ^(https://[A-Za-z0-9./_-]+|-)$ ]] && [[ "${FLAGS:--}" =~ ^[a-z,-]+$ ]] \
        || fail BAD_INPUT "Invalid release line in the settings." "Apply the settings again from KubeEZ."
    progress $((15 + 60 * (I - 1) / TOTAL)) "Installing $NAME $VERSION"
    if [ "$REPO" = "local" ]; then
        REF="$DIR/charts/$CHART"
        [ -f "$REF/Chart.yaml" ] || fail BAD_INPUT "The chart $CHART was not handed over." "Apply the settings again from KubeEZ."
        VERSION_ARG=()
    else
        $HELM repo add "$REPO" "$URL" --force-update >/dev/null 2>&1 \
            || fail NO_INTERNET "Could not reach the Helm repository $URL." "Allow this control-plane to reach $(echo "$URL" | cut -d/ -f3) (and the image registries), then retry."
        REF="$REPO/$CHART"
        VERSION_ARG=(--version "$VERSION")
    fi
    # CRDs first: Helm never upgrades the CRDs of a chart by itself
    if [[ ",$FLAGS," == *",crds,"* ]]; then
        log "Applying the CRDs of $CHART $VERSION..."
        OUT=$($HELM show crds "$REF" "${VERSION_ARG[@]}" 2>/dev/null | kubectl apply --server-side --force-conflicts -f - 2>&1) \
            || fail CRDS_FAILED "Could not apply the CRDs of $CHART: $(echo "$OUT" | tail -1)" "Check 'kubectl get crd', then retry."
    fi
    PREV=$($HELM -n "$NS" history "$NAME" --max 1 -o json 2>/dev/null | grep -o '"revision":[0-9]*' | tail -1 | cut -d: -f2)
    MODE=(); WHAT="Installing"
    [ -n "$PREV" ] && WHAT="Changing"
    if [ -n "$TAKEOVER" ] && ! ever_deployed "$NAME"; then
        # client-side apply: Helm 4's default (server-side) conflicts with the
        # fields the older kubectl apply owns; this replaces them cleanly
        MODE=(--take-ownership); WHAT="Taking over"
        [[ "$HV" =~ ^v3\. ]] || MODE+=(--server-side=false)
    elif [[ ",$FLAGS," != *",norollback,"* ]]; then
        MODE=("$ROLLBACK")
    fi
    # charts whose controllers keep their own webhook certificates up to date
    # (Vault injector, Gatekeeper, ECK): Helm 4's server-side apply would
    # conflict with that field on every upgrade — use the classic 3-way merge
    if [[ ",$FLAGS," == *",csa,"* ]] && [[ ! "$HV" =~ ^v3\. ]] && [[ " ${MODE[*]} " != *"--server-side=false"* ]]; then
        MODE+=(--server-side=false)
    fi
    VALUES=()
    [ -f "$DIR/$NAME.auto.yaml" ] && VALUES+=(-f "$DIR/$NAME.auto.yaml")
    VALUES+=(-f "$DIR/$NAME.values.yaml")
    # many images / plugins to download on the first start (Harbor, Jenkins)
    WAIT=10m
    [[ ",$FLAGS," == *",slow,"* ]] && WAIT=20m
    log "$WHAT $NAME (chart $CHART $VERSION)..."
    OUT=$($HELM upgrade --install "$NAME" "$REF" "${VERSION_ARG[@]}" --namespace "$NS" --create-namespace \
        "${VALUES[@]}" "${MODE[@]}" --wait --timeout "$WAIT" 2>&1)
    RC=$?
    echo "$OUT" | grep -v '^\s*$' | tail -4 | sed 's/^/  /'
    if [ $RC -ne 0 ]; then
        kubectl -n "$NS" get pods 2>/dev/null | sed 's/^/  /'
        WHY=$(echo "$OUT" | grep -iE 'error|failed' | tail -1)
        if [ -n "$TAKEOVER" ] && ! ever_deployed "$NAME"; then
            fail TAKEOVER_FAILED "Taking over $NAME did not finish: ${WHY} Nothing was removed — the objects that ran before are still there." \
                "Check the add-on's Logs and 'kubectl -n $NS get events --sort-by=.lastTimestamp', fix the cause, then apply again."
        fi
        if [ -n "$PREV" ] && [[ ",$FLAGS," != *",norollback,"* ]]; then
            fail INSTALL_FAILED "$NAME did not become ready with the new settings — Helm put back the version that worked (revision $PREV). ${WHY}" \
                "Check the add-on's Logs, fix the setting and apply again. Nothing else changed."
        fi
        if [ -n "$PREV" ]; then
            fail INSTALL_FAILED "$NAME did not become ready after the change (it is not rolled back automatically). ${WHY}" \
                "Check the add-on's Logs and 'kubectl -n $NS get pods'; fix the cause and apply again."
        fi
        fail INSTALL_FAILED "$NAME did not become ready and was removed again. ${WHY}" \
            "Check 'kubectl -n $NS get events --sort-by=.lastTimestamp' (image pull? storage? memory?), then install again."
    fi
    log "✓ $NAME ready"
done < "$DIR/releases"

# ── 5. Objects that need the add-on running (CRDs, webhooks) ─────────────────
if [ -f "$DIR/post.yaml" ]; then
    progress 80 "Applying the configuration"
    OK=""
    for i in $(seq 1 18); do      # webhooks need a moment after the rollout
        if OUT=$(kubectl apply -f "$DIR/post.yaml" 2>&1); then OK=1; break; fi
        sleep 10
    done
    echo "$OUT" | sed 's/^/  /'
    [ -n "$OK" ] || fail CONFIG_FAILED "The add-on runs, but its configuration was refused: $(echo "$OUT" | tail -1)" \
        "Check the settings, then apply again."
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
