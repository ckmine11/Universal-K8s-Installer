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
#   e2e.sh offsite [distro]                   S3 add-on (SeaweedFS) + offsite backups to it (needs
#                                             Node + npm install in backend/)
#   e2e.sh cluster <master> <worker>...       build a 1.35 cluster and leave it running
#   e2e.sh restore <master> <worker>...       etcd restore on a multi-node cluster (needs Node)
#   e2e.sh restore-ha [distro]                etcd restore on an HA cluster: 2 control-planes + 1 worker
#   e2e.sh ha-vip [distro]                    3 control-planes behind a kube-vip virtual IP: failover when the holder dies
#   e2e.sh recover [distro]                   control-plane machine lost → rebuilt from the offsite backup
#   e2e.sh velero [distro]                    volume backups: Velero install, file data backup + restore
#   e2e.sh explorer [distro]                  KubeEZ Explorer (Radar) behind KubeEZ's proxy: RBAC, checks, uninstall
#   e2e.sh restore-upgrade [distro]           restore a pre-upgrade snapshot, then upgrade again
#   e2e.sh addons [distro]                    add-on status/logs/web UI/repair/uninstall (needs Node)
#   e2e.sh helm-addons [distro]               Metrics Server, MetalLB, Loki, Sealed Secrets, Kyverno: install,
#                                             change, rollback, uninstall (needs Node; ONLY=metallb,… for a subset)
#   e2e.sh agent [distro]                     Gateway Agent install as a service, crash/reboot recovery
#   e2e.sh agent-health [distro]              cluster topology through the agent (root/non-root, reconnect)
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
        --add-host=host.docker.internal:host-gateway \
        --tmpfs /run --tmpfs /run/lock -v /var/lib/containerd -v /var/lib/kubelet \
        ${NODE_NET_ARGS:-} "kubeez-e2e/$distro" >/dev/null || { echo "could not start $name"; exit 1; }
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
    # UPGRADE_FROM=1.34.0 → upgrades 1.34 → 1.35 → 1.36 → 1.37 (default starts at 1.35)
    local from="${UPGRADE_FROM:-1.35.0}"; local fminor; fminor=$(echo "$from" | cut -d. -f2)
    local versions="" m; for m in $(seq $((fminor + 1)) 37); do versions="$versions 1.$m.0"; done
    docker exec "$master" bash /k/node-install.sh master "$from" || return 1
    local join; join=$(docker exec "$master" cat /tmp/kubeadm-join-command.txt)
    for d in "$@"; do
        image "$d"; start_node "$PREFIX-$d-w" "$d"; workers+=("$PREFIX-$d-w")
        docker exec "$PREFIX-$d-w" bash /k/node-install.sh worker "$from" "$join" || return 1
    done
    local count=$(( ${#workers[@]} + 1 ))
    verify_cluster "$master" "1.$fminor" "${workers[0]}" "$count" || return 1

    for v in $versions; do
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

# S3 Object Storage add-on (SeaweedFS) + encrypted offsite backups to it, on a
# real node, checked with the backend's own services (needs Node 18+ and
# `npm install` in backend/). No external storage container or image needed.
cmd_offsite() {
    local distro="${1:-ubuntu2204}"; local node="$PREFIX-$distro"
    image "$distro"; start_node "$node" "$distro"
    docker cp "$AUTOMATION/addons/seaweedfs.sh" "$node:/k/" >/dev/null
    docker exec "$node" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1

    echo "== installing the S3 Object Storage add-on"
    docker exec "$node" bash /k/seaweedfs.sh > /tmp/kz-seaweedfs.log 2>&1 \
        || { tail -30 /tmp/kz-seaweedfs.log; return 1; }

    local rc
    NODE_CONTAINER="$node" node "$E2E/offsite-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# Build a 1.35 cluster (control-plane + workers) and leave it running, for
# manual debugging or other checks:  e2e.sh cluster ubuntu2204 rocky9
cmd_cluster() {
    local master_distro="$1"; shift
    local master="$PREFIX-$master_distro-cp" d
    image "$master_distro"; start_node "$master" "$master_distro"
    docker exec "$master" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    local join; join=$(docker exec "$master" cat /tmp/kubeadm-join-command.txt)
    for d in "$@"; do
        image "$d"; start_node "$PREFIX-$d-w" "$d"
        docker exec "$PREFIX-$d-w" bash /k/node-install.sh worker 1.35.0 "$join" | grep RESULT || return 1
    done
    echo "cluster up — control-plane container: $master"
}

# etcd restore on a real multi-node cluster (pods replaced after the snapshot):
# the control plane must come back on the restored data, every node Ready,
# no kubelet stuck on stale pods.  e2e.sh restore ubuntu2204 debian12
cmd_restore() {
    local master_distro="$1"; shift
    cmd_cluster "$master_distro" "$@" || return 1
    local workers="" d
    for d in "$@"; do workers="${workers:+$workers,}$PREFIX-$d-w"; done
    local rc
    MASTER_CONTAINER="$PREFIX-$master_distro-cp" WORKER_CONTAINERS="$workers" node "$E2E/restore-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# Add-on management on a real node: install, status, logs, web UI login,
# repair, uninstall (nothing left behind).  e2e.sh addons [distro]
cmd_addons() {
    local distro="${1:-ubuntu2204}"; local node="$PREFIX-$distro"
    image "$distro"; start_node "$node" "$distro"
    docker exec "$node" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    local rc
    NODE_CONTAINER="$node" node "$E2E/addons-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# Gateway Agent installer on a real node: systemd service, crash/reboot
# recovery, re-install = one copy, SSH through the agent.  e2e.sh agent [distro]
cmd_agent() {
    local distro="${1:-ubuntu2204}"; local node="$PREFIX-agent-$distro"
    image "$distro"; start_node "$node" "$distro"
    local rc
    NODE_CONTAINER="$node" node "$E2E/agent-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && docker rm -f "$node" >/dev/null 2>&1
    return $rc
}

# Topology / health through the Gateway Agent on a real cluster: root and
# non-root users, wrong password, agent reconnect.  e2e.sh agent-health [distro]
cmd_agent_health() {
    local distro="${1:-ubuntu2204}"
    cmd_cluster "$distro" || return 1
    docker cp "$AUTOMATION/addons/explorer.sh" "$PREFIX-$distro-cp:/k/" >/dev/null
    local rc
    NODE_CONTAINER="$PREFIX-$distro-cp" node "$E2E/health-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# Restore the pre-upgrade snapshot after 1.35 → 1.36 (kubeadm-config rolls back
# to v1.35.0 while the control plane stays 1.36), then 1.36 → 1.37 must still
# work.  e2e.sh restore-upgrade [distro]
cmd_restore_upgrade() {
    local distro="${1:-ubuntu2204}"; local m="$PREFIX-$distro-cp"
    image "$distro"; start_node "$m" "$distro"
    docker exec "$m" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    upgrade_node "$m" 1.36.0 master true || return 1
    local snap; snap=$(docker exec "$m" bash -c 'ls -t /var/lib/etcd-backup/etcd-pre-upgrade-*.db | head -1 | xargs basename')
    echo "== restoring $snap (taken on 1.35)"
    docker exec "$m" bash /k/etcd-restore.sh "$snap" | sed 's/^/    /'
    docker exec "$m" grep -q RESULT=OK /var/lib/etcd-backup/last-restore.log || { echo "  ✗ restore failed"; return 1; }
    local cfg; cfg=$(kubectl_on "$m" "-n kube-system get cm kubeadm-config -o jsonpath={.data.ClusterConfiguration}" | grep kubernetesVersion)
    echo "$cfg" | grep -q 'v1.36' || { echo "  ✗ kubeadm-config not corrected after restore: $cfg"; return 1; }
    echo "  ✓ restore corrected kubeadm-config ($cfg)"

    # The upgrade must also self-heal clusters restored by an older KubeEZ
    kubectl_on "$m" "-n kube-system get cm kubeadm-config -o yaml" | sed -E 's/(kubernetesVersion: *)v[0-9.]+/\1v1.35.0/' \
        | docker exec -i "$m" bash -c 'KUBECONFIG=/etc/kubernetes/admin.conf kubectl replace -f -' >/dev/null
    echo "== kubeadm-config forced back to v1.35.0; upgrading to 1.37"
    upgrade_node "$m" 1.37.0 master true || return 1
    verify_cluster "$m" 1.37 "$m" 1 || return 1
    [ -z "${KEEP:-}" ] && cmd_clean
    return 0
}

# etcd restore on an HA cluster (2 control-planes + 1 worker): the first
# control-plane is restored, the second re-joins the restored etcd.
cmd_restore_ha() {
    local distro="${1:-ubuntu2204}"
    local m1="$PREFIX-$distro-cp" m2="$PREFIX-$distro-cp2" w="$PREFIX-$distro-w"
    image "$distro"
    start_node "$m1" "$distro"
    docker exec "$m1" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    local join key; join=$(docker exec "$m1" cat /tmp/kubeadm-join-command.txt); key=$(docker exec "$m1" cat /tmp/kubeadm-cert-key.txt)
    start_node "$m2" "$distro"
    docker exec "$m2" bash /k/node-install.sh cpjoin 1.35.0 "$join" "$key" | grep -E 'RESULT' || return 1
    start_node "$w" "$distro"
    docker exec "$w" bash /k/node-install.sh worker 1.35.0 "$join" | grep RESULT || return 1
    kubectl_on "$m1" "get nodes"
    local rc
    MASTER_CONTAINERS="$m1,$m2" WORKER_CONTAINERS="$w" node "$E2E/restore-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# fresh-node <name> <distro> <ip> — (re)create a node on the fixed-IP e2e network
NET="$PREFIX-net"; NET_SUBNET="172.31.250.0/24"
cmd_fresh_node() {
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$NET_SUBNET" "$NET" >/dev/null
    image "$2"
    NODE_NET_ARGS="--network $NET --ip $3" start_node "$1" "$2"
}

# Real HA: 3 control-planes, the API on a virtual IP (kube-vip). The machine
# holding the VIP is switched off — another one takes the VIP over and the API
# keeps answering on the same address.
cmd_ha_vip() {
    local distro="${1:-ubuntu2204}" vip=172.31.250.100 rc=0
    local m1="$PREFIX-$distro-cp1" m2="$PREFIX-$distro-cp2" m3="$PREFIX-$distro-cp3"
    cmd_fresh_node "$m1" "$distro" 172.31.250.21
    docker exec -e VIP=$vip "$m1" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE|STEP' || return 1
    local join key; join=$(docker exec "$m1" cat /tmp/kubeadm-join-command.txt); key=$(docker exec "$m1" cat /tmp/kubeadm-cert-key.txt)
    check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; rc=1; fi; }
    check "join command uses the virtual IP" "grep -q '$vip:6443' <<< \"$join\""
    for n in 2 3; do
        cmd_fresh_node "$PREFIX-$distro-cp$n" "$distro" 172.31.250.2$n
        docker exec -e VIP=$vip "$PREFIX-$distro-cp$n" bash /k/node-install.sh cpjoin 1.35.0 "$join" "$key" | grep -E 'RESULT|STEP' || return 1
    done
    kubectl_on "$m1" "get nodes -o wide"
    check "kubeadm endpoint is the VIP" "kubectl_on $m1 \"-n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}'\" | grep -q 'controlPlaneEndpoint: $vip:6443'"
    check "kube-vip runs on all 3 control-planes" "[ $(kubectl_on $m1 '-n kube-system get pods --no-headers' | grep -c '^kube-vip-.* Running') -eq 3 ]"
    check "admin.conf uses the VIP" "docker exec $m1 grep -q 'server: https://$vip:6443' /etc/kubernetes/admin.conf"
    check "kube-vip uses admin.conf after init (not super-admin.conf)" "! docker exec $m1 grep -q super-admin /etc/kubernetes/manifests/kube-vip.yaml"
    local holder
    holder=$(kubectl_on "$m1" "-n kube-system get lease plndr-cp-lock -o jsonpath='{.spec.holderIdentity}'")
    echo "VIP holder: $holder"
    check "the API answers on the VIP" "[ \"$(docker exec $m2 curl -sk --max-time 5 https://$vip:6443/readyz)\" = ok ]"
    case "$holder" in *cp1) ;; *cp2|*cp3) ;; *) echo "FAIL no VIP holder"; rc=1 ;; esac
    local ok=no other
    other=$m1; [ "$holder" = "$m1" ] && other=$m2
    echo "== switching off the VIP holder $holder"
    docker stop "$holder" >/dev/null
    local t0; t0=$(date +%s)
    for _ in $(seq 1 60); do
        [ "$(docker exec "$other" curl -sk --max-time 3 https://$vip:6443/readyz 2>/dev/null)" = ok ] && { ok=yes; break; }
        sleep 2
    done
    check "API back on the VIP after the holder died ($(( $(date +%s) - t0 ))s)" "[ $ok = yes ]"
    local new
    new=$(docker exec "$other" bash -c "KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n kube-system get lease plndr-cp-lock -o jsonpath='{.spec.holderIdentity}'")
    check "another control-plane holds the VIP ($new)" "[ -n \"$new\" ] && [ \"$new\" != \"$holder\" ]"
    check "kubectl through the VIP works on a surviving node" "docker exec $other bash -c 'KUBECONFIG=/etc/kubernetes/admin.conf kubectl get nodes' | grep -q Ready"
    check "local API check (restore scripts) ignores the VIP" "docker exec $other bash -c 'source <(sed -n \"/^local_kc()/,/^}/p\" /k/etcd-member.sh); local_kc; KUBECONFIG=/root/.kubeez-local.conf kubectl get --raw=/readyz --request-timeout=5s' | grep -qx ok"
    [ -z "${KEEP:-}" ] && cmd_clean
    [ $rc = 0 ] && echo "ALL PASSED" || echo "SOME CHECKS FAILED"
    return $rc
}

# The control-plane MACHINE is lost: a fresh machine with the same IP is
# rebuilt from the encrypted offsite backup (certificates + etcd), the worker
# reconnects by itself and the workloads are still there.
cmd_recover() {
    local distro="${1:-ubuntu2204}"
    local m="$PREFIX-$distro-cp" w="$PREFIX-$distro-w" s3="$PREFIX-s3"
    cmd_fresh_node "$m" "$distro" 172.31.250.10
    docker exec "$m" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    local join; join=$(docker exec "$m" cat /tmp/kubeadm-join-command.txt)
    cmd_fresh_node "$w" "$distro" 172.31.250.11
    docker exec "$w" bash /k/node-install.sh worker 1.35.0 "$join" | grep RESULT || return 1

    echo "== S3 storage outside the cluster (SeaweedFS container)"
    docker rm -f "$s3" >/dev/null 2>&1
    # config written inside the container (no host temp file: Git Bash paths differ)
    local s3cfg='{"identities":[{"name":"e2e","credentials":[{"accessKey":"E2EACCESS","secretKey":"e2e-secret-key-1234567890"}],"actions":["Admin","Read","Write","List","Tagging"]}]}'
    docker run -d --name "$s3" --network "$NET" --ip 172.31.250.5 --entrypoint sh chrislusf/seaweedfs:4.48         -c "echo '$s3cfg' > /etc/s3.json && exec weed server -s3 -dir=/data -s3.config=/etc/s3.json" >/dev/null || return 1
    for _ in $(seq 1 30); do docker exec "$s3" sh -c 'echo "s3.bucket.create -name backups" | weed shell' 2>/dev/null | grep -qv error && break; sleep 2; done

    local rc
    MASTER_CONTAINER="$m" WORKER_CONTAINERS="$w" DISTRO="$distro" S3_ENDPOINT="http://172.31.250.5:8333" node "$E2E/recover-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && { cmd_clean; docker network rm "$NET" >/dev/null 2>&1; }
    return $rc
}

# Velero volume backups on a real node, S3 = the cluster's own S3 add-on:
# install, file data in a pod volume backed up, namespace deleted, restored
# (in place and as a copy), schedule, uninstall.
cmd_velero() {
    local distro="${1:-ubuntu2204}"; local node="$PREFIX-$distro"
    image "$distro"; start_node "$node" "$distro"
    docker cp "$AUTOMATION/addons/seaweedfs.sh" "$node:/k/" >/dev/null
    docker cp "$AUTOMATION/addons/velero.sh" "$node:/k/" >/dev/null
    docker exec "$node" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    echo "== installing the S3 Object Storage add-on (backup target)"
    docker exec "$node" bash /k/seaweedfs.sh > /tmp/kz-seaweedfs.log 2>&1 || { tail -30 /tmp/kz-seaweedfs.log; return 1; }
    local rc
    NODE_CONTAINER="$node" node "$E2E/velero-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# KubeEZ Explorer (Radar) on a real node, reached through KubeEZ's own proxy
cmd_explorer() {
    local distro="${1:-ubuntu2204}"; local node="$PREFIX-$distro"
    image "$distro"; start_node "$node" "$distro"
    docker cp "$AUTOMATION/addons/explorer.sh" "$node:/k/" >/dev/null
    docker exec "$node" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    local rc
    NODE_CONTAINER="$node" node "$E2E/explorer-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

# Helm add-ons with settings on a real node, through KubeEZ's own path.
# e2e.sh helm-addons [distro]   (ONLY=metallb,kyverno for a subset)
cmd_helm_addons() {
    local distro="${1:-ubuntu2204}"; local node="$PREFIX-$distro"
    image "$distro"; start_node "$node" "$distro"
    docker exec "$node" bash /k/node-install.sh master 1.35.0 | grep -E 'RESULT|NODE' || return 1
    local rc
    NODE_CONTAINER="$node" node "$E2E/helm-addons-check.mjs"
    rc=$?
    [ -z "${KEEP:-}" ] && cmd_clean
    return $rc
}

cmd_clean() { docker ps -aq --filter "name=$PREFIX-" | xargs -r docker rm -f >/dev/null 2>&1; true; }

case "${1:-}" in
    install) shift; cmd_install "$@" ;;
    upgrade) shift; cmd_upgrade "$@" ;;
    offsite) shift; cmd_offsite "$@" ;;
    cluster) shift; cmd_cluster "$@" ;;
    restore) shift; cmd_restore "$@" ;;
    restore-upgrade) shift; cmd_restore_upgrade "$@" ;;
    restore-ha) shift; cmd_restore_ha "$@" ;;
    recover) shift; cmd_recover "$@" ;;
    fresh-node) shift; cmd_fresh_node "$@" ;;
    velero)  shift; cmd_velero "$@" ;;
    ha-vip)  shift; cmd_ha_vip "$@" ;;
    explorer) shift; cmd_explorer "$@" ;;
    addons)  shift; cmd_addons "$@" ;;
    helm-addons) shift; cmd_helm_addons "$@" ;;
    agent)   shift; cmd_agent "$@" ;;
    agent-health) shift; cmd_agent_health "$@" ;;
    clean)   cmd_clean ;;
    *) sed -n '2,22p' "$0"; exit 2 ;;
esac
