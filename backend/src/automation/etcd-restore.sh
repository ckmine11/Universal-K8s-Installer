#!/bin/bash
# KubeEZ — etcd snapshot restore (single control-plane / stacked etcd)
#
# Usage: etcd-restore.sh <snapshot-filename>
#   The file must already exist in /var/lib/etcd-backup/.
#
# NOTE: intentionally NOT using `set -e` — we handle every step explicitly and
# log exactly what failed, so the UI shows a precise reason instead of a generic
# "Remote command failed".

# Log to BOTH stdout and a file. The control plane restart can drop the SSH
# stream mid-run, so the backend reads this file back to show the full log.
BK_DIR="/var/lib/etcd-backup"
mkdir -p "$BK_DIR" 2>/dev/null || true
LOG_FILE="$BK_DIR/last-restore.log"
: > "$LOG_FILE" 2>/dev/null || true
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

# ── 1. Ensure a usable RESTORE tool ───────────────────────────────────────────
# etcd 3.6+ REMOVED `etcdctl snapshot restore` — restore lives in `etcdutl`.
# Detect the etcd IMAGE + VERSION from the manifest.  Use -h so grep does NOT
# prefix "filename:" (that broke the version parse before).
IMG=$(grep -hoE 'image: *[^ ]*etcd:[^ ]+' "$MANIFESTS/etcd.yaml" 2>/dev/null | head -1 | awk '{print $2}')
[ -z "$IMG" ] && IMG=$(grep -hoE '[^ "]*etcd:[^ "]+' "$MANIFESTS/etcd.yaml" 2>/dev/null | head -1)
EV=$(printf '%s' "$IMG" | sed -n 's/.*etcd:\([0-9][0-9.]*\).*/\1/p')
ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && ARCH=arm64
log "Detected etcd image=$IMG version=${EV:-unknown}"

# Copy etcdutl/etcdctl out of a root filesystem directory.
copy_tools() {
    local root="$1" b p
    for b in etcdutl etcdctl; do
        for p in "$root/usr/local/bin/$b" "$root/usr/bin/$b" "$root/bin/$b"; do
            if [ -f "$p" ]; then cp -f "$p" /usr/local/bin/$b 2>/dev/null && chmod +x /usr/local/bin/$b 2>/dev/null; break; fi
        done
    done
}

# Method 1 (BEST, offline): the etcd container is RUNNING — grab etcdutl straight
# from its live filesystem via /proc/<pid>/root. No internet, no mounts, no tar.
from_proc() {
    command -v crictl >/dev/null 2>&1 || return 1
    local CID PID
    CID=$(crictl ps --name etcd -q 2>/dev/null | head -1)
    [ -z "$CID" ] && return 1
    PID=$(crictl inspect "$CID" 2>/dev/null | grep -m1 '"pid"' | grep -oE '[0-9]+' | head -1)
    [ -z "$PID" ] && return 1
    [ -e "/proc/$PID/root/usr/local/bin/etcdutl" ] || return 1
    log "Extracting etcdutl from the running etcd container (pid $PID)..."
    copy_tools "/proc/$PID/root"
    command -v etcdutl >/dev/null 2>&1
}

# Method 2 (offline): mount the etcd image.
from_image_mount() {
    command -v ctr >/dev/null 2>&1 || return 1
    local ref="$IMG"; [ -z "$ref" ] && ref=$(ctr -n k8s.io images ls -q 2>/dev/null | grep -m1 '/etcd:')
    [ -z "$ref" ] && return 1
    local MNT=/mnt/kubeez-etcdimg; mkdir -p "$MNT"
    log "Extracting etcdutl from image $ref (offline mount)..."
    ctr -n k8s.io images mount "$ref" "$MNT" >/dev/null 2>&1 || ctr -n k8s.io image mount "$ref" "$MNT" >/dev/null 2>&1 || return 1
    copy_tools "$MNT"
    ctr -n k8s.io images unmount "$MNT" >/dev/null 2>&1 || ctr -n k8s.io image unmount "$MNT" >/dev/null 2>&1 || true
    command -v etcdutl >/dev/null 2>&1
}

# Method 3 (fallback): download from GitHub (needs internet + valid version).
download_tools() {
    [ -z "$EV" ] && return 1
    local URL="https://github.com/etcd-io/etcd/releases/download/v${EV}/etcd-v${EV}-linux-${ARCH}.tar.gz"
    log "Downloading etcd tools v${EV} (${ARCH})..."
    curl -fsSL --retry 3 -m 120 "$URL" -o /tmp/etcd.tgz 2>/dev/null || return 1
    tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null || return 1
    copy_tools "/tmp/etcd-v${EV}-linux-${ARCH}"
    command -v etcdutl >/dev/null 2>&1
}

# Ensure etcdutl: host → running container → image mount → download.
if ! command -v etcdutl >/dev/null 2>&1; then
    from_proc || from_image_mount || download_tools || true
fi

# Pick the restore command: etcdutl (3.6+ and 3.5) → else legacy etcdctl.
RESTORE_CMD=""
if command -v etcdutl >/dev/null 2>&1; then
    RESTORE_CMD="etcdutl snapshot restore"
elif command -v etcdctl >/dev/null 2>&1 && etcdctl snapshot restore --help >/dev/null 2>&1; then
    RESTORE_CMD="etcdctl snapshot restore"
else
    fail "No usable restore tool: etcd ${EV:-unknown} needs 'etcdutl', which could not be found or downloaded. Cluster untouched."
fi
log "Restore tool: $RESTORE_CMD (etcd v${EV:-unknown})"

TS=$(date +%s)

# ── 2. Stop kube-apiserver + etcd (move their static-pod manifests aside) ─────
mkdir -p "$HELD"
log "Stopping kube-apiserver and etcd static pods..."
mv -f "$MANIFESTS/kube-apiserver.yaml" "$HELD/" 2>/dev/null || true
mv -f "$MANIFESTS/etcd.yaml"           "$HELD/" 2>/dev/null || true
# Wait for the etcd container to actually disappear before touching its data.
for i in $(seq 1 12); do
    if command -v crictl >/dev/null 2>&1; then
        crictl ps 2>/dev/null | grep -q ' etcd ' || break
    fi
    sleep 2
done
sleep 3

# ── 3. Preserve current data dir as a rollback copy ───────────────────────────
if [ -d /var/lib/etcd ]; then
    log "Preserving current data dir → /var/lib/etcd-prerestore-${TS}"
    mv /var/lib/etcd "/var/lib/etcd-prerestore-${TS}" || fail "Could not move current /var/lib/etcd (is etcd still running?)"
fi

# ── 4. Restore the snapshot (offline op — NO cert/endpoint flags) ─────────────
log "Restoring snapshot into /var/lib/etcd ..."
if ! ETCDCTL_API=3 $RESTORE_CMD "$SNAP" --data-dir /var/lib/etcd; then
    log "⚠️ Restore failed — rolling back to the previous data dir."
    rm -rf /var/lib/etcd 2>/dev/null || true
    mv "/var/lib/etcd-prerestore-${TS}" /var/lib/etcd 2>/dev/null || true
    # Put manifests back so the cluster returns to its pre-restore state.
    mv -f "$HELD/etcd.yaml"           "$MANIFESTS/" 2>/dev/null || true
    mv -f "$HELD/kube-apiserver.yaml" "$MANIFESTS/" 2>/dev/null || true
    fail "etcd snapshot restore failed — cluster rolled back to previous state."
fi

# ── 5. Restart the control plane on the restored data ─────────────────────────
log "Restarting etcd + kube-apiserver..."
mv -f "$HELD/etcd.yaml"           "$MANIFESTS/" 2>/dev/null || true
mv -f "$HELD/kube-apiserver.yaml" "$MANIFESTS/" 2>/dev/null || true
systemctl restart kubelet 2>/dev/null || true

# ── 6. Snapshot is restored; control plane is coming back. ────────────────────
# We do a SHORT health wait only (long waits risk the SSH stream dropping). The
# backend/UI keeps polling cluster health after this returns.
log "Snapshot restored. Control plane is restarting..."
KC=/etc/kubernetes/admin.conf
HEALTHY=""
for i in $(seq 1 12); do   # up to ~60s
    if KUBECONFIG=$KC kubectl get --raw='/healthz' >/dev/null 2>&1; then
        HEALTHY=1; break
    fi
    sleep 5
done
if [ -n "$HEALTHY" ]; then
    log "✓ Control plane healthy. Restore complete."
else
    log "Restore applied. Control plane still starting — it should be healthy shortly."
fi
log "Previous data preserved at: /var/lib/etcd-prerestore-${TS}"
echo "[etcd-restore] RESULT=OK" >> "$LOG_FILE"
exit 0
exit 0
