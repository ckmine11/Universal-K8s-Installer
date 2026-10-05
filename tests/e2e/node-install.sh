#!/bin/bash
# Runs inside an e2e node container. Executes KubeEZ's real install scripts
# (copied to /k) in the same order and with the same arguments as
# automationEngine does over SSH.
#
#   node-install.sh master <k8s-version e.g. 1.35.0>
#   node-install.sh worker <k8s-version> "<kubeadm join command>"
#   node-install.sh cpjoin <k8s-version> "<kubeadm join command>" <certificate key>   (HA control-plane)
#
# Prints "STEP <name> rc=<code>" per step and finally RESULT=PASS|FAIL@<step>.
ROLE="$1"; K8S_VERSION="$2"; JOIN_CMD="${3:-}"; CERT_KEY="${4:-}"   # not VERSION: /etc/os-release sets that
MINOR="${K8S_VERSION%.*}"
cd /k || exit 1
IP=$(hostname -I | awk '{print $1}')
. /etc/os-release
echo "### $ROLE on $PRETTY_NAME ($IP) — Kubernetes $K8S_VERSION"

step() {
    local name="$1"; shift
    local t0; t0=$(date +%s)
    bash "$@" > "/tmp/step-$name.log" 2>&1
    local rc=$?
    echo "STEP $name rc=$rc ($(( $(date +%s) - t0 ))s)"
    if [ $rc -ne 0 ]; then
        echo "----- last lines of $name -----"
        grep -vE 'Reading database|Verifying|Installing  |Downloading' "/tmp/step-$name.log" | tail -30
        echo "RESULT=FAIL@$name"
        exit 1
    fi
}

step preflight  preflight-checks.sh
step firewall   configure-firewall.sh "$([ "$ROLE" = cpjoin ] && echo master || echo "$ROLE")"
step containerd install-containerd.sh
step kubernetes install-kubernetes.sh "$MINOR"

if [ "$ROLE" = "worker" ]; then
    step join join-worker.sh "$JOIN_CMD"
    echo "RESULT=PASS"
    exit 0
fi
if [ "$ROLE" = "cpjoin" ]; then
    step join join-master.sh "$JOIN_CMD" "$CERT_KEY"
    echo "RESULT=PASS"
    exit 0
fi

step init init-control-plane.sh "$IP" 10.244.0.0/16 "$K8S_VERSION"
export KUBECONFIG=/etc/kubernetes/admin.conf
# TEST ENVIRONMENT ONLY (same as 'kind'): inside a container kube-proxy may not
# set nf_conntrack_max ("permission denied"). Real VMs don't need this.
kubectl -n kube-system get cm kube-proxy -o yaml | sed 's/maxPerCore: null/maxPerCore: 0/' | kubectl apply -f - >/dev/null 2>&1
kubectl -n kube-system delete pod -l k8s-app=kube-proxy >/dev/null 2>&1
step cni install-network-plugin.sh flannel 10.244.0.0/16

for _ in $(seq 1 60); do
    node=$(kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}')
    dns=$(kubectl -n kube-system get pods -l k8s-app=kube-dns --no-headers 2>/dev/null | grep -c Running)
    [ "$node" = "Ready" ] && [ "${dns:-0}" -ge 1 ] && break
    sleep 5
done
logs_ok=no
kubectl -n kube-system logs -l component=kube-scheduler --tail=1 >/dev/null 2>&1 && logs_ok=yes
echo "NODE: $(kubectl get nodes --no-headers 2>/dev/null)"
echo "CHECKS: coredns-running=${dns:-0} kubectl-logs=$logs_ok crictl=$(command -v crictl >/dev/null && echo yes || echo no)"
if [ "$node" = "Ready" ] && [ "${dns:-0}" -ge 1 ] && [ "$logs_ok" = yes ]; then
    echo "RESULT=PASS"
else
    kubectl get pods -A --no-headers 2>/dev/null | awk '{print "  pod:", $1, $2, $4}'
    echo "RESULT=FAIL@ready"
    exit 1
fi
