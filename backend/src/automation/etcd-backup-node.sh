#!/bin/bash
# KubeEZ etcd snapshot tool — installed on every control-plane as
# /usr/local/sbin/kubeez-etcd-backup. Used for "Backup Now", retention, the
# checks before a restore and the "what will change" preview; pre-upgrade
# snapshots are taken by upgrade-cluster.sh.
#
# Usage: kubeez-etcd-backup <mode> [snapshot]
#   manual       → snapshot etcd-manual-YYYYmmdd-HHMMSS.db, verify it, then prune
#   prerestore   → safety snapshot etcd-pre-restore-…db taken right before a restore
#   prune        → only apply retention (+ remove old restore leftovers)
#   tools        → make sure etcdctl / etcdutl / etcd match the cluster's etcd
#   verify <s>   → checksum + etcd's own integrity check of a snapshot
#   keys <s>     → keys in the snapshot vs. keys in the live cluster (restore preview)
#
# Every snapshot gets a <name>.sha256 next to it once it passed verification;
# a restore refuses a file whose checksum no longer matches.
#
# Retention: snapshots older than RETENTION_DAYS (default 45) are deleted, but
# the NEWEST snapshot is always kept so a restore point never disappears.
# KUBEEZ_ETCD_BACKUP_SCRIPT_VERSION=2

set -o pipefail
export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

BK=/var/lib/etcd-backup
LIB=/usr/local/lib/kubeez          # private etcd server binary (preview only)
RETENTION_DAYS="${RETENTION_DAYS:-45}"
MODE="${1:-manual}"
C="--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379"
MANIFEST=/etc/kubernetes/manifests/etcd.yaml

mkdir -p "$BK" "$LIB"

# ── Tools ────────────────────────────────────────────────────────────────────
# etcd version the cluster runs (from the static-pod manifest; the restore
# script parks it in manifests-held while the control plane is stopped)
cluster_etcd_version() {
    grep -hoE 'etcd:[0-9]+\.[0-9]+\.[0-9]+' "$MANIFEST" /etc/kubernetes/manifests-held/etcd.yaml 2>/dev/null | head -1 | cut -d: -f2
}
cluster_etcd_image() {
    grep -hoE '[^ "]*etcd:[0-9][^ "]*' "$MANIFEST" /etc/kubernetes/manifests-held/etcd.yaml 2>/dev/null | head -1
}
minor_of() { printf '%s' "$1" | grep -oE '^[0-9]+\.[0-9]+'; }
tool_minor() { minor_of "$("$1" version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; }

# Copy etcd, etcdctl, etcdutl out of a root filesystem
copy_from_root() {
    local root="$1" b p got=1
    for b in etcdctl etcdutl etcd; do
        for p in "$root/usr/local/bin/$b" "$root/usr/bin/$b" "$root/bin/$b"; do
            [ -f "$p" ] || continue
            if [ "$b" = etcd ]; then install -m0755 "$p" "$LIB/etcd"; else install -m0755 "$p" "/usr/local/bin/$b"; fi
            got=0; break
        done
    done
    return $got
}
tools_ok() {
    local want; want=$(minor_of "$(cluster_etcd_version)")
    command -v etcdctl >/dev/null 2>&1 && command -v etcdutl >/dev/null 2>&1 && [ -x "$LIB/etcd" ] || return 1
    # A host tool from an older etcd (left from before an upgrade) must not
    # restore a newer cluster's snapshot
    [ -z "$want" ] || { [ "$(tool_minor etcdutl)" = "$want" ] && [ "$(tool_minor etcdctl)" = "$want" ]; }
}
# Same version as the cluster, offline first: running etcd → etcd image → download
ensure_tools() {
    tools_ok && return 0
    local ev img a cid pid mnt
    ev=$(cluster_etcd_version); img=$(cluster_etcd_image)
    if command -v crictl >/dev/null 2>&1; then
        cid=$(crictl ps --name '^etcd$' -q 2>/dev/null | head -1)
        pid=$([ -n "$cid" ] && crictl inspect "$cid" 2>/dev/null | grep -m1 '"pid"' | grep -oE '[0-9]+' | head -1)
        [ -n "$pid" ] && [ -d "/proc/$pid/root" ] && copy_from_root "/proc/$pid/root" && tools_ok && return 0
    fi
    if [ -n "$img" ] && command -v ctr >/dev/null 2>&1; then
        mnt=$(mktemp -d)
        if ctr -n k8s.io images mount "$img" "$mnt" >/dev/null 2>&1; then
            copy_from_root "$mnt"
            ctr -n k8s.io images unmount "$mnt" >/dev/null 2>&1
        fi
        rmdir "$mnt" 2>/dev/null
        tools_ok && return 0
    fi
    [ -z "$ev" ] && ev=3.5.16
    a=amd64; [ "$(uname -m)" = "aarch64" ] && a=arm64
    if curl -fsSL --retry 3 -m 180 "https://github.com/etcd-io/etcd/releases/download/v$ev/etcd-v$ev-linux-$a.tar.gz" -o /tmp/kz-etcd.tgz 2>/dev/null \
        && tar xzf /tmp/kz-etcd.tgz -C /tmp 2>/dev/null; then
        copy_from_root "/tmp/etcd-v$ev-linux-$a" >/dev/null 2>&1 || true
        install -m0755 "/tmp/etcd-v$ev-linux-$a/etcdctl" /usr/local/bin/etcdctl 2>/dev/null
        install -m0755 "/tmp/etcd-v$ev-linux-$a/etcdutl" /usr/local/bin/etcdutl 2>/dev/null
        install -m0755 "/tmp/etcd-v$ev-linux-$a/etcd" "$LIB/etcd" 2>/dev/null
        rm -rf /tmp/kz-etcd.tgz "/tmp/etcd-v$ev-linux-$a"
    fi
    tools_ok
}

safe_name() { case "$1" in ""|*/*|*..*) return 1;; *.db) return 0;; *) return 1;; esac; }

# verify_snapshot <file> → prints "rev|keys|size" or a reason; non-zero = damaged
verify_snapshot() {
    local f="$1" st rev
    [ -s "$f" ] || { echo "the file is empty or missing"; return 1; }
    if [ -f "$f.sha256" ]; then
        [ "$(sha256sum "$f" | awk '{print $1}')" = "$(awk '{print $1}' "$f.sha256")" ] \
            || { echo "checksum mismatch — the file changed or was damaged after the backup was taken"; return 1; }
    fi
    st=$(etcdutl snapshot status "$f" -w json 2>&1) || { echo "etcd cannot read it: $(printf '%s' "$st" | tail -1)"; return 1; }
    rev=$(printf '%s' "$st" | grep -oE '"revision": *[0-9]+' | grep -oE '[0-9]+$')
    [ -n "$rev" ] && [ "$rev" -gt 0 ] || { echo "etcd reports no data in it"; return 1; }
    echo "$rev|$(printf '%s' "$st" | grep -oE '"totalKey": *[0-9]+' | grep -oE '[0-9]+$')|$(stat -c %s "$f")"
}

# Snapshot + verification + checksum. $1 = file name prefix
take_snapshot() {
    ensure_tools || { echo "SAVE_FAILED: could not get etcdctl/etcdutl $(cluster_etcd_version) (no running etcd, image or internet)"; exit 1; }
    local snap="$BK/etcd-$1-$(date +%Y%m%d-%H%M%S).db" v
    if ! ETCDCTL_API=3 etcdctl $C snapshot save "$snap" >/tmp/kubeez-etcd-save.log 2>&1; then
        rm -f "$snap" "$snap.part" 2>/dev/null
        echo "SAVE_FAILED:"; cat /tmp/kubeez-etcd-save.log
        exit 1
    fi
    if ! v=$(verify_snapshot "$snap"); then
        rm -f "$snap"
        echo "SAVE_FAILED: the snapshot was written but failed verification ($v)"
        exit 1
    fi
    sha256sum "$snap" | awk -v n="$(basename "$snap")" '{print $1"  "n}' > "$snap.sha256"
    echo "SNAPSHOT_OK:$snap"
    echo "VERIFIED:$v"
}

# ── Retention ────────────────────────────────────────────────────────────────
prune() {
    local newest pruned=0 f
    newest=$(ls -1t "$BK"/*.db 2>/dev/null | head -1)
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        [ "$f" = "$newest" ] && continue
        rm -f "$f" "$f.sha256" && pruned=$((pruned + 1))
    done < <(find "$BK" -maxdepth 1 -type f -name '*.db' -mmin +$((RETENTION_DAYS * 1440)) 2>/dev/null)
    # checksums whose snapshot is gone
    for f in "$BK"/*.db.sha256; do [ -e "$f" ] && [ ! -e "${f%.sha256}" ] && rm -f "$f"; done
    # Every restore keeps the replaced etcd data as a rollback copy — a full
    # copy of the database each time. Keep the newest 2, so the disk can't fill.
    ls -1dt /var/lib/etcd-prerestore-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
    ls -1dt /var/lib/etcd-failed-restore-* 2>/dev/null | tail -n +2 | xargs -r rm -rf
    rm -rf "$BK"/.preview-* 2>/dev/null
    echo "PRUNED:$pruned (older than ${RETENTION_DAYS} days)"
}

# ── Restore preview: keys in the snapshot vs. keys in the live cluster ───────
# A throw-away etcd (localhost, other ports) serves a copy of the snapshot so
# its keys can be listed. Output: SNAPREV|n, S|<key> (snapshot), L|<key>|<modrev> (live)
# PREVIEW_PID / PREVIEW_DIR are global: the EXIT trap runs after this function
# returned, when its locals are gone (an empty "wait" would block forever).
preview_keys() {
    local f="$1" v rev i
    v=$(verify_snapshot "$f") || { echo "PREVIEW_FAIL|DAMAGED|$v"; exit 1; }
    rev="${v%%|*}"
    local need=$(( $(stat -c %s "$f") / 1024 + 102400 ))
    [ "$(df -Pk "$BK" | awk 'NR==2{print $4}')" -gt "$need" ] || { echo "PREVIEW_FAIL|DISK|not enough free disk space for the preview"; exit 1; }
    PREVIEW_DIR="$BK/.preview-$$"; PREVIEW_PID=""
    local dir="$PREVIEW_DIR"
    rm -rf "$dir"
    trap '[ -n "$PREVIEW_PID" ] && { kill "$PREVIEW_PID" 2>/dev/null; wait "$PREVIEW_PID" 2>/dev/null; }; rm -rf "$PREVIEW_DIR"' EXIT
    local P=(--name preview --initial-cluster preview=http://127.0.0.1:23800 --initial-advertise-peer-urls http://127.0.0.1:23800)
    etcdutl snapshot restore "$f" --data-dir "$dir/data" "${P[@]}" >/dev/null 2>&1 || { echo "PREVIEW_FAIL|RESTORE|could not unpack the snapshot"; exit 1; }
    "$LIB/etcd" "${P[@]}" --data-dir "$dir/data" \
        --listen-client-urls http://127.0.0.1:23790 --advertise-client-urls http://127.0.0.1:23790 \
        --listen-peer-urls http://127.0.0.1:23800 >"$dir/etcd.log" 2>&1 &
    PREVIEW_PID=$!
    for i in $(seq 1 30); do
        etcdctl --endpoints=http://127.0.0.1:23790 endpoint health >/dev/null 2>&1 && break
        sleep 1
    done
    etcdctl --endpoints=http://127.0.0.1:23790 endpoint health >/dev/null 2>&1 \
        || { echo "PREVIEW_FAIL|START|$(tail -2 "$dir/etcd.log" | tr '|\n' '/ ')"; exit 1; }
    echo "SNAPREV|$rev"
    etcdctl --endpoints=http://127.0.0.1:23790 get /registry --prefix --keys-only 2>/dev/null | awk 'NF{print "S|"$0}'
    # -w fields: "Key" : "…" then "ModRevision" : n for every key
    ETCDCTL_API=3 etcdctl $C get /registry --prefix --keys-only -w fields 2>/dev/null \
        | awk -F' : ' '/^"Key"/{k=$2; gsub(/^"|"$/,"",k)} /^"ModRevision"/{print "L|"k"|"$2}'
    echo "PREVIEW_OK"
}

case "$MODE" in
    manual)     take_snapshot manual; prune ;;
    prerestore) take_snapshot pre-restore ;;
    prune)      prune ;;
    tools)
        if ensure_tools; then echo "TOOLS_OK|$(tool_minor etcdutl)"
        else echo "TOOLS_FAIL|could not get etcdctl/etcdutl $(cluster_etcd_version) (no running etcd, image or internet)"; exit 1; fi ;;
    verify|keys)
        safe_name "${2:-}" || { echo "VERIFY_FAIL|invalid snapshot name"; exit 1; }
        [ -f "$BK/$2" ] || { echo "VERIFY_FAIL|snapshot not found on this node"; exit 1; }
        ensure_tools || { echo "VERIFY_FAIL|could not get etcdutl $(cluster_etcd_version) to check the snapshot"; exit 1; }
        if [ "$MODE" = keys ]; then preview_keys "$BK/$2"; exit $?; fi
        if v=$(verify_snapshot "$BK/$2"); then
            # Snapshots from older KubeEZ versions get their checksum now
            [ -f "$BK/$2.sha256" ] || sha256sum "$BK/$2" | awk -v n="$2" '{print $1"  "n}' > "$BK/$2.sha256"
            echo "VERIFY_OK|$v"
        else
            echo "VERIFY_FAIL|$v"; exit 1
        fi ;;
    *) echo "SAVE_FAILED: unknown mode '$MODE'"; exit 1 ;;
esac
exit 0
