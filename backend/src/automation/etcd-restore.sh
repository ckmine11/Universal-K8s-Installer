#!/bin/bash
# KubeEZ — etcd snapshot restore (single control-plane / stacked etcd)
#
# Usage: etcd-restore.sh <snapshot-filename>
#   The file must already exist in /var/lib/etcd-backup/.
#
# Procedure (standard kubeadm stacked-etcd restore):
#   1. Ensure an etcdctl binary is available on the host.
#   2. Stop the apiserver + etcd static pods (move their manifests aside).
#   3. Move the live data dir aside (kept as a rollback copy).
#   4. Restore the snapshot into a fresh /var/lib/etcd.
#   5. Put the manifests back so kubelet restarts etcd + apiserver.
set -e

log() { echo "[etcd-restore] $1"; }

SNAP_NAME="${1:-}"
BK_DIR="/var/lib/etcd-backup"
SNAP="${BK_DIR}/${SNAP_NAME}"
MANIFESTS="/etc/kubernetes/manifests"
HELD="/etc/kubernetes/manifests-held"
CERTS="--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key"

if [ -z "$SNAP_NAME" ]; then log "❌ No snapshot filename provided"; exit 1; fi
# Reject path traversal — only a bare filename in BK_DIR is allowed.
case "$SNAP_NAME" in */*|*..*) log "❌ Invalid snapshot name"; exit 1;; esac
if [ ! -f "$SNAP" ]; then log "❌ Snapshot not found: $SNAP"; exit 1; fi

log "Restoring etcd from: $SNAP"

# 1. Ensure etcdctl on host — copy it out of the running etcd pod if missing.
if ! command -v etcdctl >/dev/null 2>&1; then
    log "etcdctl not on host — extracting it from the etcd pod..."
    KC="--kubeconfig=/etc/kubernetes/admin.conf"
    POD=$(kubectl $KC -n kube-system get pods -l component=etcd -o jsonpath="{.items[0].metadata.name}" 2>/dev/null)
    if [ -n "$POD" ]; then
        kubectl $KC -n kube-system cp "$POD:/usr/local/bin/etcdctl" /usr/local/bin/etcdctl 2>/dev/null || true
        chmod +x /usr/local/bin/etcdctl 2>/dev/null || true
    fi
fi
if ! command -v etcdctl >/dev/null 2>&1; then
    log "❌ Could not obtain etcdctl — cannot restore safely. Aborting (cluster untouched)."
    exit 1
fi

TS=$(date +%s)

# 2. Stop apiserver + etcd (kubelet removes the pods once manifests are gone).
mkdir -p "$HELD"
log "Stopping kube-apiserver and etcd static pods..."
mv -f "$MANIFESTS/kube-apiserver.yaml" "$HELD/" 2>/dev/null || true
mv -f "$MANIFESTS/etcd.yaml" "$HELD/" 2>/dev/null || true
sleep 12   # give kubelet time to tear the static pods down

# 3. Preserve the current data dir as a rollback copy.
if [ -d /var/lib/etcd ]; then
    log "Backing up current etcd data dir → /var/lib/etcd-prerestore-${TS}"
    mv /var/lib/etcd "/var/lib/etcd-prerestore-${TS}" 2>/dev/null || true
fi

# 4. Restore the snapshot into a fresh data dir.
log "Restoring snapshot into /var/lib/etcd ..."
if ! ETCDCTL_API=3 etcdctl snapshot restore "$SNAP" --data-dir /var/lib/etcd $CERTS 2>/dev/null; then
    # Older etcdctl doesn't accept cert flags on restore (it's offline) — retry plain.
    ETCDCTL_API=3 etcdctl snapshot restore "$SNAP" --data-dir /var/lib/etcd
fi

# 5. Put the manifests back so the control plane restarts on the restored data.
log "Restarting etcd + kube-apiserver..."
mv -f "$HELD/etcd.yaml" "$MANIFESTS/" 2>/dev/null || true
mv -f "$HELD/kube-apiserver.yaml" "$MANIFESTS/" 2>/dev/null || true

# 6. Wait for the API server to come back.
log "Waiting for control plane to become healthy..."
for i in $(seq 1 30); do
    if kubectl --kubeconfig=/etc/kubernetes/admin.conf get --raw='/healthz' >/dev/null 2>&1; then
        log "✓ Control plane healthy. Restore complete."
        log "   Rollback copy of previous data: /var/lib/etcd-prerestore-${TS}"
        exit 0
    fi
    sleep 5
done

log "⚠️ Restore applied but the API server did not report healthy within 150s."
log "   It may still be starting. Previous data preserved at /var/lib/etcd-prerestore-${TS}"
exit 0
