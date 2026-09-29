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

# ── Stop kube-apiserver + etcd (move their static-pod manifests aside) ─────────
mkdir -p "$HELD"
log "Stopping kube-apiserver and etcd static pods..."
mv -f "$MANIFESTS/kube-apiserver.yaml" "$HELD/" 2>/dev/null || true
mv -f "$MANIFESTS/etcd.yaml"           "$HELD/" 2>/dev/null || true
for i in $(seq 1 15); do
    command -v crictl >/dev/null 2>&1 || break
    crictl ps 2>/dev/null | grep -q ' etcd ' || break
    sleep 2
done
sleep 3

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
    etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd && restore_ok=1
fi
# 2) run etcdutl straight from the etcd IMAGE (no host binary, fully offline)
if [ -z "$restore_ok" ] && command -v ctr >/dev/null 2>&1 && [ -n "$IMG" ]; then
    log "Restoring via etcd image using 'ctr run' (offline, no host etcdutl needed)..."
    if ctr -n k8s.io run --rm \
        --mount type=bind,src=/var/lib,dst=/var/lib,options=rbind:rw \
        "$IMG" kubeez-etcd-restore-${TS} \
        etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd 2>>"$LOG_FILE"; then
        restore_ok=1
    fi
fi
# 3) acquire etcdutl (running container → download), then restore
if [ -z "$restore_ok" ]; then
    from_proc || from_download || true
    if command -v etcdutl >/dev/null 2>&1; then
        log "Restoring with acquired etcdutl..."
        etcdutl snapshot restore "$SNAP" --data-dir /var/lib/etcd && restore_ok=1
    fi
fi
# 4) legacy etcdctl (etcd <= 3.5)
if [ -z "$restore_ok" ] && command -v etcdctl >/dev/null 2>&1; then
    log "Restoring with host etcdctl (legacy)..."
    ETCDCTL_API=3 etcdctl snapshot restore "$SNAP" --data-dir /var/lib/etcd && restore_ok=1
fi

if [ -z "$restore_ok" ]; then
    log "⚠️ Restore did not run — rolling back to previous data."
    rm -rf /var/lib/etcd 2>/dev/null || true
    mv "/var/lib/etcd-prerestore-${TS}" /var/lib/etcd 2>/dev/null || true
    mv -f "$HELD/etcd.yaml"           "$MANIFESTS/" 2>/dev/null || true
    mv -f "$HELD/kube-apiserver.yaml" "$MANIFESTS/" 2>/dev/null || true
    fail "Could not restore: no working etcdutl (host/image/download all failed). Cluster rolled back."
fi

# ownership: etcd runs as root in the static pod
chown -R root:root /var/lib/etcd 2>/dev/null || true

# ── Restart the control plane on the restored data ────────────────────────────
log "Restarting etcd + kube-apiserver..."
mv -f "$HELD/etcd.yaml"           "$MANIFESTS/" 2>/dev/null || true
mv -f "$HELD/kube-apiserver.yaml" "$MANIFESTS/" 2>/dev/null || true
systemctl restart kubelet 2>/dev/null || true

# ── Short health wait (long waits risk dropping the SSH stream) ───────────────
log "Snapshot restored. Control plane is restarting..."
KC=/etc/kubernetes/admin.conf
HEALTHY=""
for i in $(seq 1 12); do
    if KUBECONFIG=$KC kubectl get --raw='/healthz' >/dev/null 2>&1; then HEALTHY=1; break; fi
    sleep 5
done
[ -n "$HEALTHY" ] && log "✓ Control plane healthy. Restore complete." \
                  || log "Restore applied. Control plane still starting — should be healthy shortly."
log "Previous data preserved at: /var/lib/etcd-prerestore-${TS}"
echo "[etcd-restore] RESULT=OK" >> "$LOG_FILE"
exit 0
