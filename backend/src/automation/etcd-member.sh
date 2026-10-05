#!/bin/bash
# KubeEZ — etcd member helper for restoring HA (multi control-plane) clusters.
#
# A restore brings etcd back as a single member on the first control-plane
# (etcd-restore.sh). The other control-planes are stopped before that and then
# re-added one by one with a fresh, empty data dir — etcd copies the restored
# data to them.
#
#   etcd-member.sh info                          → MEMBER_OK|<name>|<peer-url> of this node
#   etcd-member.sh stop                          → stop this node's control plane
#   etcd-member.sh start                         → start it again (abort: nothing changed)
#   etcd-member.sh add <name> <peer-url>         → on the FIRST control-plane: register a member
#   etcd-member.sh remove <name> [<peer-url>]    → on the FIRST control-plane: drop a member again
#   etcd-member.sh rejoin <name> <peer> [<name> <peer>…]
#                                                → on a stopped member: empty data dir, join the
#                                                  restored cluster (args = full member list)
#
# Ends with MEMBER_OK or MEMBER_FAIL|<reason>.

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
MANIFESTS=/etc/kubernetes/manifests
HELD=/etc/kubernetes/manifests-held
KC=/etc/kubernetes/admin.conf
CP_PODS="kube-apiserver kube-controller-manager kube-scheduler etcd"
C="--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379"
TS=$(date +%s)

log()  { echo "[etcd-member] $1"; }
fail() { echo "MEMBER_FAIL|$1"; exit 1; }
ok()   { echo "MEMBER_OK${1:+|$1}"; exit 0; }

manifest() { [ -f "$MANIFESTS/etcd.yaml" ] && echo "$MANIFESTS/etcd.yaml" || echo "$HELD/etcd.yaml"; }
flag() { grep -oE -- "--$1=[^ \"]+" "$(manifest)" 2>/dev/null | head -1 | cut -d= -f2-; }
running_cp() { local p; for p in $CP_PODS; do [ -n "$(crictl ps --name "^${p}\$" -q 2>/dev/null)" ] && echo "$p"; done; }
# kubeadm's etcd serves /health on the plain-http metrics port — no etcdctl
# needed on this node (only the first control-plane has KubeEZ's etcd tools)
etcd_healthy() {
    curl -s -m 5 http://127.0.0.1:2381/health 2>/dev/null | grep -q '"health":"true"' && return 0
    command -v etcdctl >/dev/null 2>&1 && ETCDCTL_API=3 etcdctl $C endpoint health >/dev/null 2>&1
}
# etcdctl for add/remove (first control-plane): KubeEZ's tool fetches a matching one
need_etcdctl() {
    command -v etcdctl >/dev/null 2>&1 || /usr/local/sbin/kubeez-etcd-backup tools >/dev/null 2>&1
    command -v etcdctl >/dev/null 2>&1 || fail "etcdctl is not available on this control-plane"
}
api_ready() { [ "$(KUBECONFIG=$KC kubectl get --raw='/readyz' --request-timeout=5s 2>/dev/null)" = "ok" ]; }
valid() { [[ "$1" =~ ^[a-zA-Z0-9._-]+$ ]]; }
valid_url() { [[ "$1" =~ ^https?://[a-zA-Z0-9.:_-]+$ ]]; }

case "${1:-}" in
info)
    [ -f "$(manifest)" ] || fail "no etcd manifest on this node (not a stacked-etcd control-plane)"
    n=$(flag name); u=$(flag initial-advertise-peer-urls)
    [ -n "$n" ] && [ -n "$u" ] || fail "no etcd name / peer URL in this node's etcd manifest"
    ok "$n|$u" ;;

stop)
    mkdir -p "$HELD"
    for p in $CP_PODS; do mv -f "$MANIFESTS/$p.yaml" "$HELD/" 2>/dev/null || true; done
    for _ in $(seq 1 24); do [ -z "$(running_cp)" ] && ok stopped; sleep 5; done
    for p in $(running_cp); do crictl ps --name "^${p}\$" -q 2>/dev/null | xargs -r crictl stop >/dev/null 2>&1; done
    sleep 5
    [ -z "$(running_cp)" ] && ok stopped
    for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done
    fail "could not stop: $(running_cp | tr '\n' ' ')" ;;

start)
    for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done
    for _ in $(seq 1 36); do api_ready && ok started; sleep 5; done
    fail "the API server on this node did not come back within 3 minutes" ;;

add)
    valid "${2:-}" && valid_url "${3:-}" || fail "invalid member name or peer URL"
    need_etcdctl
    out=$(ETCDCTL_API=3 etcdctl $C member add "$2" --peer-urls="$3" 2>&1) || fail "etcd refused to add $2: $(tail -1 <<< "$out")"
    ok added ;;

remove)
    valid "${2:-}" || fail "invalid member name"
    need_etcdctl
    # "id, started, name, peerURLs, …" — a member that never started has no
    # name yet, so match the peer URL too
    id=$(ETCDCTL_API=3 etcdctl $C member list 2>/dev/null | awk -F', ' -v n="$2" -v u="${3:-none}" '$3==n || $4==u {print $1; exit}')
    [ -n "$id" ] || ok "not a member"
    ETCDCTL_API=3 etcdctl $C member remove "$id" >/dev/null 2>&1 || fail "could not remove member $2"
    ok removed ;;

rejoin)
    shift
    [ $# -ge 4 ] && [ $(( $# % 2 )) -eq 0 ] || fail "rejoin needs the full member list: <name> <peer> pairs"
    initial=""
    while [ $# -gt 0 ]; do
        valid "$1" && valid_url "$2" || fail "invalid member '$1 $2'"
        initial="${initial:+$initial,}$1=$2"; shift 2
    done
    [ -f "$HELD/etcd.yaml" ] || fail "this control-plane was not stopped first"
    log "Joining the restored etcd cluster: $initial"
    if [ -d /var/lib/etcd ]; then
        mv /var/lib/etcd "/var/lib/etcd-prerestore-$TS" || fail "could not move /var/lib/etcd aside"
        log "Old data kept at /var/lib/etcd-prerestore-$TS"
    fi
    sed -i -E "s#--initial-cluster=[^ \"]+#--initial-cluster=${initial}#" "$HELD/etcd.yaml"
    if grep -q -- '--initial-cluster-state=' "$HELD/etcd.yaml"; then
        sed -i -E 's#--initial-cluster-state=[a-z]+#--initial-cluster-state=existing#' "$HELD/etcd.yaml"
    else
        sed -i -E 's#^( *)- --initial-cluster=(.*)$#\1- --initial-cluster=\2\n\1- --initial-cluster-state=existing#' "$HELD/etcd.yaml"
    fi
    grep -q -- '--initial-cluster-state=existing' "$HELD/etcd.yaml" || fail "could not update this node's etcd manifest"
    for p in $CP_PODS; do mv -f "$HELD/$p.yaml" "$MANIFESTS/" 2>/dev/null || true; done
    for _ in $(seq 1 36); do etcd_healthy && break; sleep 5; done
    etcd_healthy || fail "etcd on this node did not join within 3 minutes ($(crictl logs --tail 3 "$(crictl ps -a --name '^etcd$' -q | head -1)" 2>&1 | tail -1))"
    log "✓ etcd member synced"
    for _ in $(seq 1 36); do api_ready && break; sleep 5; done
    api_ready || fail "etcd joined, but the API server on this node did not become ready"
    systemctl restart kubelet 2>/dev/null || true
    ls -1dt /var/lib/etcd-prerestore-* 2>/dev/null | tail -n +3 | xargs -r rm -rf
    ok joined ;;

*) fail "unknown command '${1:-}'" ;;
esac
