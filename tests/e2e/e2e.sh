#!/bin/bash
# End-to-end tests for KubeEZ's install/upgrade scripts on real distros.
#
# Each "node" is a privileged systemd container (the same technique 'kind'
# uses), so kubeadm, containerd, kubelet and flannel really run. Needs Docker
# on a Linux host with cgroups v2 (GitHub Actions ubuntu runners, Docker Desktop).
#
#   e2e.sh install <distro> [k8s-version]   fresh single-node cluster (default 1.35.0)
#   e2e.sh upgrade <master> <worker>...       1.35 cluster + workers, then real
#                                             upgrades 1.35 → 1.36 → 1.37 on every node
#   e2e.sh clean                              remove all e2e containers
#
# distros: ubuntu2204 ubuntu2404 debian12 rocky9 alma9 fedora amzn2023
set -uo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite container paths

ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
E2E="$ROOT/tests/e2e"
AUTOMATION="$ROOT/backend/src/automation"
PREFIX="kz-e2e"

image() { docker build -q -t "kubeez-e2e/$1" "$E2E/images/$1" >/dev/null || { echo "image build failed: $1"; exit 1; }; }

# start_node <name> <distro> — boot a fresh node container with the scripts in /k
start_node() {
    local name="$1" distro="$2"
    docker rm -f "$name" >/dev/null 2>&1
    docker run -d --name "$name" --hostname "$name" --privileged --cgroupns=private \
        --tmpfs /run --tmpfs /run/lock -v /var/lib/containerd -v /var/lib/kubelet \
        "kubeez-e2e/$distro" >/dev/null || { echo "could not start $name"; exit 1; }
    for _ in $(seq 1 30); do docker exec "$name" systemctl is-system-running >/dev/null 2>&1 && break
        [ "$(docker exec "$name" systemctl is-system-running 2>/dev/null)" = degraded ] && break; sleep 1; done
    docker exec "$name" mkdir -p /k
    for f in "$AUTOMATION"/*.sh "$E2E/node-install.sh"; do docker cp "$f" "$name:/k/" >/dev/null; done
}

kubectl_on() { docker exec "$1" bash -c "KUBECONFIG=/etc/kubernetes/admin.conf kubectl $2"; }

cmd_install() {
    local distro="$1" version="${2:-1.35.0}" name="$PREFIX-$1"
    image "$distro"; start_node "$name" "$distro"
    docker exec "$name" bash /k/node-install.sh master "$version"
    local rc=$?
    [ -z "${KEEP:-}" ] && docker rm -f "$name" >/dev/null 2>&1
    return $rc
}

# upgrade_node <container> <version> <role> <first-master true|false>
upgrade_node() {
    local out
    for mode in check upgrade; do
        out=$(docker exec "$1" bash /k/upgrade-cluster.sh "$2" "$3" "$4" "$mode" 2>&1)
        if [ $? -ne 0 ]; then
            echo "  ✗ $1 $mode $2: $(echo "$out" | grep -oE 'KUBEEZ_FAIL\|.*' | tail -1)"
            echo "$out" | grep -vE 'Reading database|Get:|Hit:|Unpacking|Selecting|Preparing' | tail -25 | sed 's/^/      /'
            return 1
        fi
    done
    echo "  ✓ $1 upgraded to $2 (progress: $(echo "$out" | grep -oE 'KUBEEZ_PROGRESS\|[0-9]+' | cut -d'|' -f2 | tr '\n' ' '))"
}

# verify_cluster <master> <version-prefix> <worker> <node-count>
# every node Ready at <version>, and a pod on <worker> resolves cluster DNS
verify_cluster() {
    local master="$1" version="$2" worker="$3" expected="$4" nodes
    for _ in $(seq 1 60); do
        nodes=$(kubectl_on "$master" "get nodes --no-headers" 2>/dev/null)
        [ "$(echo "$nodes" | grep -c " Ready ")" -ge "$expected" ] && [ "$(echo "$nodes" | grep -c "v$version")" -ge "$expected" ] && break
        sleep 5
    done
    echo "$nodes" | awk '{print "    node:", $1, $2, $5}'
    [ "$(echo "$nodes" | grep " Ready " | grep -c "v$version")" -ge "$expected" ] || { echo "  ✗ not all nodes Ready at v$version"; return 1; }
    local pod="dns-$(date +%s)" phase=""
    kubectl_on "$master" "run $pod --image=busybox:1.36 --restart=Never --overrides='{\"spec\":{\"nodeName\":\"$worker\"}}' -- nslookup kubernetes.default.svc.cluster.local" >/dev/null 2>&1
    for _ in $(seq 1 40); do phase=$(kubectl_on "$master" "get pod $pod -o jsonpath={.status.phase}" 2>/dev/null); [ "$phase" = Succeeded ] || [ "$phase" = Failed ] && break; sleep 3; done
    [ "$phase" = Succeeded ] || { echo "  ✗ pod on $worker could not resolve cluster DNS ($phase)"; return 1; }
    echo "  ✓ all nodes Ready at v$version; pod on $worker resolves cluster DNS"
}

cmd_upgrade() {
    local master_distro="$1"; shift
    local master="$PREFIX-$master_distro-cp" workers=() d
    image "$master_distro"; start_node "$master" "$master_distro"
    docker exec "$master" bash /k/node-install.sh master 1.35.0 || return 1
    local join; join=$(docker exec "$master" cat /tmp/kubeadm-join-command.txt)
    for d in "$@"; do
        image "$d"; start_node "$PREFIX-$d-w" "$d"; workers+=("$PREFIX-$d-w")
        docker exec "$PREFIX-$d-w" bash /k/node-install.sh worker 1.35.0 "$join" || return 1
    done
    local count=$(( ${#workers[@]} + 1 ))
    verify_cluster "$master" 1.35 "${workers[0]}" "$count" || return 1

    for v in 1.36.0 1.37.0; do
        echo "== upgrade to $v"
        upgrade_node "$master" "$v" master true || return 1
        for w in "${workers[@]}"; do upgrade_node "$w" "$v" worker false || return 1; done
        verify_cluster "$master" "$v" "${workers[0]}" "$count" || return 1
    done

    # The upgrade must have taken automatic pre-upgrade etcd snapshots
    local snaps; snaps=$(docker exec "$master" bash -c 'ls /var/lib/etcd-backup/etcd-pre-upgrade-*.db 2>/dev/null | wc -l')
    [ "$snaps" -ge 2 ] || { echo "  ✗ expected 2 pre-upgrade etcd snapshots, found $snaps"; return 1; }
    echo "  ✓ $snaps automatic pre-upgrade etcd snapshots"
    [ -z "${KEEP:-}" ] && cmd_clean
    return 0
}

cmd_clean() { docker ps -aq --filter "name=$PREFIX-" | xargs -r docker rm -f >/dev/null 2>&1; true; }

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    upgrade) shift; cmd_upgrade "$@" ;;
    clean)   cmd_clean ;;
    *) sed -n '2,14p' "$0"; exit 2 ;;
esac
