#!/bin/bash
# KubeEZ — etcd snapshot restore (single control-plane / stacked etcd)
#
# Usage: etcd-restore.sh <snapshot-filename>   (file lives in /var/lib/etcd-backup/)
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
# Log to stdout AND a file — the control-plane restart can drop the SSH stream,
# and the backend reads this file back to show the full log + result.
log()  { echo "[etcd-restore] $1" | tee -a "$LOG_FILE"; }
fail() { echo "[etcd-restore] ❌ $1" | tee -a "$LOG_FILE"; echo "[etcd-restore] RESULT=FAILED" >> "$LOG_FILE"; exit 1; }

SNAP_NAME="${1:-}"
SNAP="${BK_DIR}/${SNAP_NAME}"
MANIFESTS="/etc/kubernetes/manifests"
HELD="/etc/kubernetes/manifests-held"

[ -n "$SNAP_NAME" ] || fail "No snapshot filename provided"
case "$SNAP_NAME" in */*|*..*) fail "Invalid snapshot name";; esac
[ -f "$SNAP" ] || fail "Snapshot not found: $SNAP"

log "Restoring etcd from: $SNAP"

# Detect the etcd IMAGE + VERSION from the manifest (-h → no filename prefix).
IMG=$(grep -hoE 'image: *[^ ]*etcd:[^ ]+' "$MANIFESTS/etcd.yaml" "$HELD/etcd.yaml" 2>/dev/null | head -1 | awk '{print $2}')
[ -z "$IMG" ] && IMG=$(grep -hoE '[^ "]*etcd:[^ "]+' "$MANIFESTS/etcd.yaml" "$HELD/etcd.yaml" 2>/dev/null | head -1)
EV=$(printf '%s' "$IMG" | sed -n 's/.*etcd:\([0-9][0-9.]*\).*/\1/p')
ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && ARCH=arm64
log "Detected etcd image=${IMG:-none} version=${EV:-unknown}"

copy_tools() {   # copy etcdutl/etcdctl out of a rootfs dir into /usr/local/bin
    local root="$1" b p
    for b in etcdutl etcdctl; do
        for p in "$root/usr/local/bin/$b" "$root/usr/bin/$b" "$root/bin/$b"; do
            if [ -f "$p" ]; then cp -f "$p" /usr/local/bin/$b 2>/dev/null && chmod +x /usr/local/bin/$b 2>/dev/null; break; fi
        done
    done
}
from_proc() {          # etcdutl from the RUNNING etcd container via /proc
    command -v crictl >/dev/null 2>&1 || return 1
    local CID PID
    CID=$(crictl ps --name etcd -q 2>/dev/null | head -1)
    [ -z "$CID" ] && return 1
    PID=$(crictl inspect "$CID" 2>/dev/null | grep -m1 '"pid"' | grep -oE '[0-9]+' | head -1)
    [ -z "$PID" ] && return 1
    [ -e "/proc/$PID/root/usr/local/bin/etcdutl" ] || return 1
    log "Extracting etcdutl from running etcd container (pid $PID)..."
    copy_tools "/proc/$PID/root"; command -v etcdutl >/dev/null 2>&1
}
from_download() {      # last resort — needs internet + a valid version tag
    [ -z "$EV" ] && return 1
    log "Downloading etcd tools v${EV} (${ARCH})..."
    curl -fsSL --retry 3 -m 120 "https://github.com/etcd-io/etcd/releases/download/v${EV}/etcd-v${EV}-linux-${ARCH}.tar.gz" -o /tmp/etcd.tgz 2>/dev/null || return 1
    tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null || return 1
    copy_tools "/tmp/etcd-v${EV}-linux-${ARCH}"; command -v etcdutl >/dev/null 2>&1
}

TS=$(date +%s)

# ── Stop the WHOLE control plane (move its static-pod manifests aside) ────────
# kube-apiserver, controller-manager and scheduler cache cluster state. If any
# of them survives the restore it keeps serving data NEWER than the restored
# etcd ("Too large resource version"), and kubelets then fail with
# "no relationship found between node … and this object". kubelet only
# re-reads manifests every ~20 s, so we must WAIT until the containers are gone.
CP_PODS="kube-apiserver kube-controller-manager kube-scheduler etcd"
mkdir -p "$HELD"
log "Stopping the control plane (api-server, controller-manager, scheduler, etcd)..."
for p in $CP_PODS; do mv -f "$MANIFESTS/$p.yaml" "$HELD/" 2>/dev/null || true; done

running_cp() {   # names of control-plane containers still running
    local p
    for p in $CP_PODS; do
        [ -n "$(crictl ps --name "^${p}\$" -q 2>/dev/null)" ] && echo "$p"
    done
}
if command -v crictl >/dev/null 2>&1; then
    for i in $(seq 1 24); do              # up to 2 min
        [ -z "$(running_cp)" ] && break
        sleep 5
    done
    if [ -n "$(running_cp)" ]; then
        log "Still running after 2 min: $(running_cp | tr '\n' ' ') — stopping them directly..."
        for p in $(running_cp); do crictl ps --name "^${p}\$" -q 2>/dev/null | xargs -r crictl stop >/dev/null 2>&1; done
        sleep 5
    fi
    if [ -n "$(running_cp)" ]; then
        for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done
        fail "Could not stop the control plane ($(running_cp | tr '\n' ' ')). Nothing was restored; the cluster is unchanged."
    fi
    log "✓ Control plane stopped."
else
    log "crictl not found — waiting 60 s for kubelet to stop the control plane..."
    sleep 60
fi

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
if [ -d /var/lib/etcd ]; then
    log "Preserving current data dir → /var/lib/etcd-prerestore-${TS}"
    mv /var/lib/etcd "/var/lib/etcd-prerestore-${TS}" || fail "Could not move current /var/lib/etcd"
fi

# ── Restore — try methods in order until one works (all offline-capable) ──────
restore_ok=""
# 1) host etcdutl
if command -v etcdutl >/dev/null 2>&1; then
    log "Restoring with host etcdutl..."
    etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" && restore_ok=1
fi
# 2) run etcdutl straight from the etcd IMAGE (no host binary, fully offline)
if [ -z "$restore_ok" ] && command -v ctr >/dev/null 2>&1 && [ -n "$IMG" ]; then
    log "Restoring via etcd image using 'ctr run' (offline, no host etcdutl needed)..."
    if ctr -n k8s.io run --rm \
        --mount type=bind,src=/var/lib,dst=/var/lib,options=rbind:rw \
        "$IMG" kubeez-etcd-restore-${TS} \
        etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" 2>>"$LOG_FILE"; then
        restore_ok=1
    fi
fi
# 3) acquire etcdutl (running container → download), then restore
if [ -z "$restore_ok" ]; then
    from_proc || from_download || true
    if command -v etcdutl >/dev/null 2>&1; then
        log "Restoring with acquired etcdutl..."
        etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" && restore_ok=1
    fi
fi
# 4) legacy etcdctl (etcd <= 3.5)
if [ -z "$restore_ok" ] && command -v etcdctl >/dev/null 2>&1; then
    log "Restoring with host etcdctl (legacy)..."
    ETCDCTL_API=3 etcdctl snapshot restore "$SNAP" --data-dir /var/lib/etcd "${RESTORE_FLAGS[@]}" && restore_ok=1
fi

if [ -z "$restore_ok" ]; then
    log "⚠️ Restore did not run — rolling back to previous data."
    rm -rf /var/lib/etcd 2>/dev/null || true
    mv "/var/lib/etcd-prerestore-${TS}" /var/lib/etcd 2>/dev/null || true
    for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done
    fail "Could not restore: no working etcdutl (host/image/download all failed). Cluster rolled back."
fi

# ownership: etcd runs as root in the static pod
chown -R root:root /var/lib/etcd 2>/dev/null || true

# ── Start the control plane on the restored data ─────────────────────────────
log "Starting the control plane on the restored data..."
for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done

KC=/etc/kubernetes/admin.conf
api_ready() { [ "$(KUBECONFIG=$KC kubectl get --raw='/readyz' 2>/dev/null)" = "ok" ]; }
wait_api() {     # $1 = seconds
    local i
    for i in $(seq 1 $(( $1 / 5 ))); do api_ready && return 0; sleep 5; done
    return 1
}
if ! wait_api 180; then
    log "Previous data preserved at: /var/lib/etcd-prerestore-${TS}"
    log "Manual rollback: move /etc/kubernetes/manifests/*.yaml aside, replace /var/lib/etcd with that copy, move the manifests back."
    fail "The API server did not become ready within 3 minutes after the restore. Check 'crictl ps -a' and 'crictl logs <kube-apiserver id>' on this node."
fi
log "✓ API server ready on the restored data."

# kubelet still remembers pods created AFTER the snapshot; a restart makes it
# drop them and resync from the restored API ("no relationship found" otherwise).
log "Restarting kubelet so it drops pods that are not in the snapshot..."
systemctl restart kubelet 2>/dev/null || true
wait_api 120 || fail "The API server stopped responding after the kubelet restart."

NODE_STATE=$(KUBECONFIG=$KC kubectl get nodes --no-headers 2>/dev/null | awk '{print $1"="$2}' | tr '\n' ' ')
log "✓ Restore complete. Nodes: ${NODE_STATE}"
log "Previous data preserved at: /var/lib/etcd-prerestore-${TS}"
echo "[etcd-restore] RESULT=OK" >> "$LOG_FILE"
exit 0
