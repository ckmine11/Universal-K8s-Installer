#!/bin/bash
# KubeEZ — etcd snapshot restore (single control-plane / stacked etcd)
#
# Usage: etcd-restore.sh <snapshot-filename>
#   The file must already exist in /var/lib/etcd-backup/.
#
# NOTE: intentionally NOT using `set -e` — we handle every step explicitly and
# log exactly what failed, so the UI shows a precise reason instead of a generic
# "Remote command failed".

log()  { echo "[etcd-restore] $1"; }
fail() { echo "[etcd-restore] ❌ $1"; exit 1; }

SNAP_NAME="${1:-}"
BK_DIR="/var/lib/etcd-backup"
SNAP="${BK_DIR}/${SNAP_NAME}"
MANIFESTS="/etc/kubernetes/manifests"
HELD="/etc/kubernetes/manifests-held"

[ -n "$SNAP_NAME" ] || fail "No snapshot filename provided"
case "$SNAP_NAME" in */*|*..*) fail "Invalid snapshot name";; esac
[ -f "$SNAP" ] || fail "Snapshot not found: $SNAP"

log "Restoring etcd from: $SNAP"

# ── 1. Ensure a usable RESTORE tool ───────────────────────────────────────────
# IMPORTANT: etcd 3.6+ REMOVED `etcdctl snapshot restore` — restore now lives in
# the separate `etcdutl` binary. So we must prefer etcdutl; only very old
# clusters (<=3.5) use `etcdctl snapshot restore`.
EV=$(grep -oE 'etcd:[0-9]+\.[0-9]+\.[0-9]+' "$MANIFESTS/etcd.yaml" 2>/dev/null | head -1 | cut -d: -f2)
[ -z "$EV" ] && EV=$(grep -oE 'image:.*etcd:[0-9.]+' "$MANIFESTS/etcd.yaml" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && ARCH=arm64

download_tools() {
    local V="${1:-$EV}"
    [ -z "$V" ] && V="3.5.16"
    local URL="https://github.com/etcd-io/etcd/releases/download/v${V}/etcd-v${V}-linux-${ARCH}.tar.gz"
    log "Downloading etcd tools v${V} (${ARCH})..."
    curl -fsSL --retry 3 -m 120 "$URL" -o /tmp/etcd.tgz 2>/dev/null || return 1
    tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null || return 1
    local D="/tmp/etcd-v${V}-linux-${ARCH}"
    [ -f "$D/etcdutl" ] && install -m0755 "$D/etcdutl" /usr/local/bin/etcdutl 2>/dev/null
    [ -f "$D/etcdctl" ] && install -m0755 "$D/etcdctl" /usr/local/bin/etcdctl 2>/dev/null
    return 0
}

# Get etcdutl if it's not already on the host (matches the running etcd version).
command -v etcdutl >/dev/null 2>&1 || download_tools "$EV" || true

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

# ── 6. Wait for the API server to become healthy ──────────────────────────────
log "Waiting for the control plane to become healthy..."
KC=/etc/kubernetes/admin.conf
for i in $(seq 1 36); do   # up to ~3 min
    if KUBECONFIG=$KC kubectl get --raw='/healthz' >/dev/null 2>&1; then
        log "✓ Control plane healthy. Restore complete."
        log "   Previous data preserved at: /var/lib/etcd-prerestore-${TS}"
        exit 0
    fi
    sleep 5
done

log "⚠️ Restore applied but the API server has not reported healthy yet (it may still be starting)."
log "   Previous data preserved at: /var/lib/etcd-prerestore-${TS}"
exit 0
