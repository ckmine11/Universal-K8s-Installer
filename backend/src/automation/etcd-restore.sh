#!/bin/bash
# KubeEZ — etcd snapshot restore on the primary control-plane (stacked etcd)
#
# Usage: etcd-restore.sh <snapshot-filename>   (file lives in /var/lib/etcd-backup/)
#
# Safety, in order:
#   1. nothing is touched until the snapshot passed its checksum + etcd's own
#      integrity check and the node has the disk space it needs
#   2. a safety snapshot of the CURRENT state is taken first (one-click undo)
#   3. the current data dir is kept as a rollback copy
#   4. if the control plane does not come back on the restored data, the
#      rollback copy is put back automatically
#
# HA clusters: KubeEZ stops the other control-planes first and re-adds their
# etcd members afterwards (etcd-member.sh); this script restores the first one
# as a single-member etcd cluster.
#
# No `set -e`: every step is handled explicitly and logged, so the UI shows a
# precise reason. etcd 3.6+ removed `etcdctl snapshot restore` → we use etcdutl.

# CRITICAL: a non-interactive sudo shell has a minimal PATH, so crictl / ctr /
# etcdutl in /usr/local/bin are not found. Fix the PATH up front.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

BK_DIR="/var/lib/etcd-backup"
mkdir -p "$BK_DIR" 2>/dev/null || true
LOG_FILE="$BK_DIR/last-restore.log"
: > "$LOG_FILE" 2>/dev/null || true
TOOL_LOG="$BK_DIR/last-restore-etcdutl.log"   # etcdutl's verbose output (kept out of the UI log)
: > "$TOOL_LOG" 2>/dev/null || true
# Log to stdout AND a file — the control-plane restart can drop the SSH stream,
# and the backend reads this file back to show the full log + result.
log()  { echo "[etcd-restore] $1" | tee -a "$LOG_FILE"; }
fail() { echo "[etcd-restore] ❌ $1" | tee -a "$LOG_FILE"; echo "[etcd-restore] RESULT=FAILED" >> "$LOG_FILE"; exit 1; }
# Progress marker for the UI (step key), also kept in the log file
step() { echo "[etcd-restore] STEP=$1" >> "$LOG_FILE"; echo "KUBEEZ_PROGRESS|$2|$3"; }

SNAP_NAME="${1:-}"
# --no-safety: KubeEZ already took the safety snapshot (HA: before the other
# control-planes were stopped — without quorum etcd can't take one)
NO_SAFETY=""; [ "${2:-}" = "--no-safety" ] && NO_SAFETY=1
SNAP="${BK_DIR}/${SNAP_NAME}"
MANIFESTS="/etc/kubernetes/manifests"
HELD="/etc/kubernetes/manifests-held"
TOOL=/usr/local/sbin/kubeez-etcd-backup
KC=/etc/kubernetes/admin.conf
TS=$(date +%s)
PRE="/var/lib/etcd-prerestore-${TS}"

[ -n "$SNAP_NAME" ] || fail "No snapshot filename provided"
case "$SNAP_NAME" in */*|*..*) fail "Invalid snapshot name";; esac
[ -f "$SNAP" ] || fail "Snapshot not found on this node: $SNAP"

log "Restoring etcd from: $SNAP"

# Detect the etcd IMAGE + VERSION from the manifest (-h → no filename prefix).
IMG=$(grep -hoE 'image: *[^ ]*etcd:[^ ]+' "$MANIFESTS/etcd.yaml" "$HELD/etcd.yaml" 2>/dev/null | head -1 | awk '{print $2}')
[ -z "$IMG" ] && IMG=$(grep -hoE '[^ "]*etcd:[^ "]+' "$MANIFESTS/etcd.yaml" "$HELD/etcd.yaml" 2>/dev/null | head -1)
EV=$(printf '%s' "$IMG" | sed -n 's/.*etcd:\([0-9][0-9.]*\).*/\1/p')
ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && ARCH=arm64
log "Detected etcd image=${IMG:-none} version=${EV:-unknown}"

# ══ 1. Checks — the cluster is not touched until all of them pass ════════════
step checks 5 "Checking the snapshot"

# Restore tools matching the cluster's etcd, fetched while etcd still runs
# (they can be copied out of the running container — works offline).
if [ -x "$TOOL" ]; then
    T=$("$TOOL" tools 2>&1 | tail -1)
    case "$T" in TOOLS_OK*) log "✓ etcd tools ready (etcdutl ${T#TOOLS_OK|})";; *) log "⚠️ ${T#TOOLS_FAIL|} — will try the etcd image directly";; esac
fi

# Integrity: checksum from backup time + etcd's own check of the file
if [ -x "$TOOL" ] && command -v etcdutl >/dev/null 2>&1; then
    V=$("$TOOL" verify "$SNAP_NAME" 2>&1 | tail -1)
    case "$V" in
        VERIFY_OK*) IFS='|' read -r _ SREV SKEYS _ <<< "$V"; log "✓ Snapshot verified: checksum OK, etcd can read it (revision ${SREV}, ${SKEYS} keys)" ;;
        *) fail "The snapshot is damaged: ${V#VERIFY_FAIL|}. Nothing was changed — the cluster keeps running. Pick another snapshot." ;;
    esac
elif command -v etcdutl >/dev/null 2>&1; then
    etcdutl snapshot status "$SNAP" >/dev/null 2>&1 || fail "The snapshot is damaged (etcd cannot read it). Nothing was changed — pick another snapshot."
    log "✓ Snapshot readable by etcd"
else
    log "⚠️ No host etcdutl — the snapshot will be checked while it is restored"
fi

# Disk: the restored database + a safety snapshot, each about the snapshot's size
NEED_KB=$(( $(stat -c %s "$SNAP") * 2 / 1024 + 204800 ))
FREE_KB=$(df -Pk /var/lib | awk 'NR==2{print $4}')
if [ -n "$FREE_KB" ] && [ "$FREE_KB" -lt "$NEED_KB" ]; then
    fail "Not enough disk space in /var/lib: $((FREE_KB / 1024)) MB free, $((NEED_KB / 1024)) MB needed. Nothing was changed — free some space (old /var/lib/etcd-prerestore-* folders can go) and retry."
fi
log "✓ Disk space OK ($((FREE_KB / 1024)) MB free)"

# ══ 2. Safety snapshot of the current state (one-click undo) ═════════════════
step safety 15 "Taking a safety snapshot of the current state"
if [ -x "$TOOL" ] && [ -z "$NO_SAFETY" ]; then
    S=$("$TOOL" prerestore 2>&1)
    SAFE=$(grep -oE 'SNAPSHOT_OK:[^ ]+' <<< "$S" | head -1 | sed 's#.*/##')
    if [ -n "$SAFE" ]; then
        log "✓ Safety snapshot of the current state: $SAFE"
        log "SAFETY_SNAPSHOT=$SAFE"
    else
        log "⚠️ Could not take a safety snapshot ($(tail -1 <<< "$S")) — continuing; the current data is still kept as a rollback copy."
    fi
fi

# ══ 3. Stop the WHOLE control plane (move its static-pod manifests aside) ════
# kube-apiserver, controller-manager and scheduler cache cluster state. If any
# of them survives the restore it keeps serving data NEWER than the restored
# etcd ("Too large resource version"), and kubelets then fail with
# "no relationship found between node … and this object". kubelet only
# re-reads manifests every ~20 s, so we must WAIT until the containers are gone.
CP_PODS="kube-apiserver kube-controller-manager kube-scheduler etcd"
mkdir -p "$HELD"

running_cp() {   # names of control-plane containers still running
    local p
    for p in $CP_PODS; do
        [ -n "$(crictl ps --name "^${p}\$" -q 2>/dev/null)" ] && echo "$p"
    done
}
start_cp() { local p; for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done; }
stop_cp() {      # 0 = stopped
    local p i
    for p in $CP_PODS; do mv -f "$MANIFESTS/$p.yaml" "$HELD/" 2>/dev/null || true; done
    if ! command -v crictl >/dev/null 2>&1; then
        log "crictl not found — waiting 60 s for kubelet to stop the control plane..."
        sleep 60; return 0
    fi
    for i in $(seq 1 24); do              # up to 2 min
        [ -z "$(running_cp)" ] && return 0
        sleep 5
    done
    log "Still running after 2 min: $(running_cp | tr '\n' ' ') — stopping them directly..."
    for p in $(running_cp); do crictl ps --name "^${p}\$" -q 2>/dev/null | xargs -r crictl stop >/dev/null 2>&1; done
    sleep 5
    [ -z "$(running_cp)" ]
}

api_ready() { [ "$(KUBECONFIG=$KC kubectl get --raw='/readyz' --request-timeout=5s 2>/dev/null)" = "ok" ]; }
wait_api() {     # $1 = seconds (a real deadline, however long each check takes)
    local end=$(( SECONDS + $1 ))
    while [ $SECONDS -lt $end ]; do api_ready && return 0; sleep 5; done
    api_ready
}

# Put the data from before the restore back and start the control plane on it.
# $1 = why. Never returns.
rollback() {
    log "↩ Rolling back automatically: $1"
    step rollback 90 "Rolling back to the state before the restore"
    stop_cp || log "⚠️ Some control-plane containers are still running: $(running_cp | tr '\n' ' ')"
    if [ -d /var/lib/etcd ]; then
        mv /var/lib/etcd "/var/lib/etcd-failed-restore-${TS}" 2>/dev/null || rm -rf /var/lib/etcd
    fi
    mv "$PRE" /var/lib/etcd 2>/dev/null || {
        start_cp
        fail "$1 — AND the rollback could not move $PRE back to /var/lib/etcd. Do it by hand: move /etc/kubernetes/manifests/*.yaml aside, replace /var/lib/etcd with $PRE, move the manifests back."
    }
    start_cp
    if wait_api 240; then
        systemctl restart kubelet 2>/dev/null || true
        fail "$1. KubeEZ rolled the cluster back automatically — it runs on its data from before the restore, nothing was lost. (The failed attempt is kept at /var/lib/etcd-failed-restore-${TS} for diagnosis.)"
    fi
    fail "$1 — the rollback data is back in /var/lib/etcd but the API server did not start within 4 minutes either. Check 'crictl ps -a' and 'crictl logs <kube-apiserver id>' on this node."
}

step stop 25 "Stopping the control plane"
log "Stopping the control plane (api-server, controller-manager, scheduler, etcd)..."
if ! stop_cp; then
    start_cp
    fail "Could not stop the control plane ($(running_cp | tr '\n' ' ')). Nothing was restored; the cluster is unchanged."
fi
log "✓ Control plane stopped."

# The restored member must keep this node's etcd identity (name + peer URL),
# not etcdutl's defaults (name "default", http://localhost:2380).
ETCD_NAME=$(grep -oE -- '--name=[^ "]+' "$HELD/etcd.yaml" 2>/dev/null | head -1 | cut -d= -f2-)
ETCD_PEER=$(grep -oE -- '--initial-advertise-peer-urls=[^ "]+' "$HELD/etcd.yaml" 2>/dev/null | head -1 | cut -d= -f2-)
RESTORE_FLAGS=()
if [ -n "$ETCD_NAME" ] && [ -n "$ETCD_PEER" ]; then
    RESTORE_FLAGS=(--name "$ETCD_NAME" --initial-cluster "${ETCD_NAME}=${ETCD_PEER}" --initial-advertise-peer-urls "$ETCD_PEER")
    log "etcd member: ${ETCD_NAME} (${ETCD_PEER})"
fi

# ── Preserve current data dir as a rollback copy ──────────────────────────────
step restore 40 "Restoring the snapshot"
if [ -d /var/lib/etcd ]; then
    log "Preserving current data dir → $PRE"
    if ! mv /var/lib/etcd "$PRE"; then
        start_cp
        fail "Could not move the current /var/lib/etcd aside. Nothing was restored; the cluster is unchanged."
    fi
fi

# Kubernetes' own guidance for restores: move etcd's revision far forward and
# mark the old revisions compacted, so every controller and kubelet re-lists
# instead of trusting its cached (now newer) view. etcd 3.5.? and later.
bump_flags() {   # $@ = command that prints `snapshot restore --help`
    if "$@" 2>&1 | grep -q -- '--bump-revision'; then
        echo "--bump-revision 1000000000 --mark-compacted"
    fi
}

restore_ok=""
# 1) host etcdutl (same version as the cluster — kubeez-etcd-backup tools)
if command -v etcdutl >/dev/null 2>&1; then
    BUMP=$(bump_flags etcdutl snapshot restore --help)
    log "Restoring with host etcdutl ${BUMP:+(revision bumped, old revisions marked compacted)}..."
    # shellcheck disable=SC2086
    etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" $BUMP >>"$TOOL_LOG" 2>&1 && restore_ok=1
fi
# 2) run etcdutl straight from the etcd IMAGE (no host binary, fully offline)
if [ -z "$restore_ok" ] && command -v ctr >/dev/null 2>&1 && [ -n "$IMG" ]; then
    rm -rf /var/lib/etcd
    CTR=(ctr -n k8s.io run --rm --mount type=bind,src=/var/lib,dst=/var/lib,options=rbind:rw "$IMG")
    BUMP=$(bump_flags "${CTR[@]}" "kubeez-etcd-help-${TS}" etcdutl snapshot restore --help)
    log "Restoring via the etcd image (offline, no host etcdutl needed)..."
    # shellcheck disable=SC2086
    "${CTR[@]}" "kubeez-etcd-restore-${TS}" etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" $BUMP >>"$TOOL_LOG" 2>&1 && restore_ok=1
fi
# 3) last resort: download etcdutl for this etcd version
if [ -z "$restore_ok" ] && [ -n "$EV" ]; then
    log "Downloading etcd tools v${EV} (${ARCH})..."
    if curl -fsSL --retry 3 -m 120 "https://github.com/etcd-io/etcd/releases/download/v${EV}/etcd-v${EV}-linux-${ARCH}.tar.gz" -o /tmp/etcd.tgz 2>/dev/null \
        && tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null; then
        U="/tmp/etcd-v${EV}-linux-${ARCH}/etcdutl"
        rm -rf /var/lib/etcd
        # shellcheck disable=SC2086
        [ -x "$U" ] && "$U" snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" $(bump_flags "$U" snapshot restore --help) >>"$TOOL_LOG" 2>&1 && restore_ok=1
    fi
fi

if [ -z "$restore_ok" ]; then
    log "⚠️ The restore did not run: $(grep -iE 'error|fatal|panic' "$TOOL_LOG" | tail -1 | cut -c1-300) — putting the previous data back."
    rm -rf /var/lib/etcd 2>/dev/null || true
    mv "$PRE" /var/lib/etcd 2>/dev/null || true
    start_cp
    wait_api 180 || true
    fail "Could not restore: no working etcdutl (host, etcd image and download all failed). The cluster was rolled back to its previous data."
fi

# ownership: etcd runs as root in the static pod
chown -R root:root /var/lib/etcd 2>/dev/null || true

# ══ 4. Start the control plane on the restored data ══════════════════════════
step start 60 "Starting the control plane on the restored data"
log "Starting the control plane on the restored data..."
start_cp
# e2e only: simulate a restore that leaves etcd unable to start (damaged disk)
if [ -n "${KUBEEZ_TEST_BREAK_RESTORE:-}" ]; then
    find /var/lib/etcd -name db -path '*snap*' -exec truncate -s 4096 {} \; 2>/dev/null
fi
wait_api 180 || rollback "The API server did not become ready within 3 minutes on the restored data"
log "✓ API server ready on the restored data."

# A snapshot taken BEFORE an upgrade carries the old kubeadm-config
# (kubernetesVersion v1.35.0) while the static pods on disk stay newer (v1.36).
# The next 'kubeadm upgrade' would then refuse to run — bring the record in
# line with the control plane that actually runs (only ever upwards).
CFG_VER=$(KUBECONFIG=$KC kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' 2>/dev/null \
    | grep -oE 'kubernetesVersion: *v[0-9]+\.[0-9]+\.[0-9]+' | grep -oE 'v[0-9.]+' | head -1)
SRV_VER=$(KUBECONFIG=$KC kubectl version -o json 2>/dev/null | grep -A12 '"serverVersion"' | grep '"gitVersion"' | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -n "$CFG_VER" ] && [ -n "$SRV_VER" ] && [ "$CFG_VER" != "$SRV_VER" ] \
   && [ "$(printf '%s\n%s\n' "${CFG_VER#v}" "${SRV_VER#v}" | sort -V | head -1)" = "${CFG_VER#v}" ]; then
    log "kubeadm-config says ${CFG_VER} (from the snapshot) but the control plane runs ${SRV_VER} — correcting it..."
    KUBECONFIG=$KC kubectl -n kube-system get cm kubeadm-config -o yaml \
        | sed -E "s/(kubernetesVersion: *)v[0-9]+\.[0-9]+\.[0-9]+/\1${SRV_VER}/" \
        | KUBECONFIG=$KC kubectl replace -f - >/dev/null 2>&1 \
        && log "✓ kubeadm-config now records ${SRV_VER}" \
        || log "⚠️ Could not update kubeadm-config — before the next upgrade run: kubectl -n kube-system edit cm kubeadm-config (set kubernetesVersion: ${SRV_VER})"
fi

# kubelet still remembers pods created AFTER the snapshot; a restart makes it
# drop them and resync from the restored API ("no relationship found" otherwise).
step kubelet 80 "Refreshing the kubelet"
log "Restarting kubelet so it drops pods that are not in the snapshot..."
systemctl restart kubelet 2>/dev/null || true
wait_api 120 || fail "The API server stopped responding after the kubelet restart. The restored data is in place; the data from before the restore is kept at $PRE."

# Old rollback copies are full database copies — keep the newest 2
ls -1dt /var/lib/etcd-prerestore-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
ls -1dt /var/lib/etcd-failed-restore-* 2>/dev/null | tail -n +2 | xargs -r rm -rf

NODE_STATE=$(KUBECONFIG=$KC kubectl get nodes --no-headers 2>/dev/null | awk '{print $1"="$2}' | tr '\n' ' ')
log "✓ Restore complete. Nodes: ${NODE_STATE}"
log "Previous data preserved at: $PRE"
echo "[etcd-restore] RESULT=OK" >> "$LOG_FILE"
exit 0
