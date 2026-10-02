#!/bin/bash
# KubeEZ etcd snapshot + retention — installed on the primary control-plane as
# /usr/local/sbin/kubeez-etcd-backup and run daily by kubeez-etcd-backup.timer.
#
# Usage: kubeez-etcd-backup [daily|manual|prune]
#   daily|manual → take a snapshot named etcd-<kind>-YYYYmmdd-HHMMSS.db, then prune
#   prune        → only apply retention
#
# Retention: snapshots older than RETENTION_DAYS (default 45) are deleted, but
# the NEWEST snapshot is always kept so a restore point never disappears.
# KUBEEZ_ETCD_BACKUP_SCRIPT_VERSION=1

set -o pipefail
export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

BK=/var/lib/etcd-backup
RETENTION_DAYS="${RETENTION_DAYS:-45}"
KIND="${1:-daily}"
C="--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379"

mkdir -p "$BK"

if [ "$KIND" != "prune" ]; then
    case "$KIND" in daily|manual) ;; *) echo "SAVE_FAILED: unknown kind '$KIND'"; exit 1;; esac

    # Host etcdctl (download the version matching the cluster's etcd if missing).
    # We avoid exec-ing inside the etcd pod: distroless etcd images have no shell.
    if ! command -v etcdctl >/dev/null 2>&1; then
        EV=$(grep -oE "etcd:[0-9]+\.[0-9]+\.[0-9]+" /etc/kubernetes/manifests/etcd.yaml 2>/dev/null | head -1 | cut -d: -f2)
        [ -z "$EV" ] && EV=3.5.16
        A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64
        curl -fsSL --retry 3 -m 120 "https://github.com/etcd-io/etcd/releases/download/v$EV/etcd-v$EV-linux-$A.tar.gz" -o /tmp/etcd.tgz 2>/dev/null \
            && tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null \
            && install -m0755 "/tmp/etcd-v$EV-linux-$A/etcdctl" /usr/local/bin/etcdctl 2>/dev/null
    fi
    command -v etcdctl >/dev/null 2>&1 || { echo "SAVE_FAILED: could not find or download etcdctl"; exit 1; }

    SNAP="$BK/etcd-$KIND-$(date +%Y%m%d-%H%M%S).db"
    if ETCDCTL_API=3 etcdctl $C snapshot save "$SNAP" >/tmp/kubeez-etcd-save.log 2>&1; then
        echo "SNAPSHOT_OK:$SNAP"
    else
        rm -f "$SNAP" "$SNAP.part" 2>/dev/null
        echo "SAVE_FAILED:"; cat /tmp/kubeez-etcd-save.log
        exit 1
    fi
fi

# ── Retention ────────────────────────────────────────────────────────────────
NEWEST=$(ls -1t "$BK"/*.db 2>/dev/null | head -1)
PRUNED=0
while IFS= read -r f; do
    [ -z "$f" ] && continue
    [ "$f" = "$NEWEST" ] && continue
    rm -f "$f" && PRUNED=$((PRUNED + 1))
done < <(find "$BK" -maxdepth 1 -type f -name '*.db' -mmin +$((RETENTION_DAYS * 1440)) 2>/dev/null)
echo "PRUNED:$PRUNED (older than ${RETENTION_DAYS} days)"
exit 0
