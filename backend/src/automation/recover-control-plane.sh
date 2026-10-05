#!/bin/bash
# KubeEZ — rebuild a LOST control-plane from an offsite backup (disaster recovery)
#
# Usage: recover-control-plane.sh <node-ip>
#
# Runs on a freshly installed machine that takes the place of the lost
# control-plane (same IP, so the workers find it again), after KubeEZ's usual
# preparation (preflight, firewall, containerd, kubeadm/kubelet of the cluster's
# minor). The offsite bundle has already been downloaded + decrypted into
# /var/lib/kubeez-recovery: etcd-snapshot.db, pki/, kubeadm-config.yaml, MANIFEST.
#
# What it does: puts the cluster's certificate authorities back (so every
# worker, kubeconfig and service-account token stays valid), restores etcd from
# the snapshot, and lets kubeadm build the control plane around that data.
#
# Ends with RECOVER_OK or KUBEEZ_FAIL|CODE|reason|fix.

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
IP="${1:-}"
R=/var/lib/kubeez-recovery
KC=/etc/kubernetes/admin.conf

log()  { echo "[recover] $1"; }
fail() { echo "KUBEEZ_FAIL|$1|$2|$3"; echo "[recover] ❌ $2"; exit 1; }
progress() { echo "KUBEEZ_PROGRESS|$1|$2"; }

[[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail BAD_INPUT "Missing or invalid node IP" "This is a KubeEZ bug — please report it."
[ -s "$R/etcd-snapshot.db" ] && [ -f "$R/pki/ca.crt" ] && [ -f "$R/pki/ca.key" ] \
    || fail NO_BUNDLE "The offsite backup was not downloaded to this machine (or has no certificates)" "Retry the recovery; the backup bundle is fetched first."
hostname -I | tr ' ' '\n' | grep -qx "$IP" \
    || fail WRONG_IP "This machine does not have the IP $IP" "The replacement machine must use the lost control-plane's IP ($IP) so the workers can reach it."
if [ -f /etc/kubernetes/manifests/kube-apiserver.yaml ] || [ -f /etc/kubernetes/manifests-held/kube-apiserver.yaml ]; then
    fail ALREADY_RUNNING "This machine already runs a Kubernetes control plane" "Recovery is only for a rebuilt machine. To roll back a running cluster, use Restore instead."
fi

NAME=$(hostname | tr 'A-Z' 'a-z')
KVER=$(kubeadm version -o short 2>/dev/null)
[ -n "$KVER" ] || fail NO_KUBEADM "kubeadm is not installed" "The preparation step did not finish — retry the recovery."
BVER=$(sed -n 's/^kubeadm: *//p' "$R/MANIFEST" 2>/dev/null)
log "Recovering on $NAME ($IP) with kubeadm $KVER — the backup was taken on ${BVER:-unknown}"
if [ -n "$BVER" ] && [ "$(cut -d. -f1-2 <<< "${BVER#v}")" != "$(cut -d. -f1-2 <<< "${KVER#v}")" ]; then
    fail VERSION_MISMATCH "The backup was taken on Kubernetes $BVER but $KVER is installed" "Install the same minor version as the backup."
fi

# ── 1. Certificates: keep the CAs and the service-account key, let kubeadm
#      issue fresh leaf certificates for this machine ─────────────────────────
progress 10 "Restoring the cluster certificates"
mkdir -p /etc/kubernetes
rm -rf /etc/kubernetes/pki
cp -a "$R/pki" /etc/kubernetes/pki
for c in apiserver apiserver-kubelet-client apiserver-etcd-client front-proxy-client etcd/server etcd/peer etcd/healthcheck-client; do
    rm -f "/etc/kubernetes/pki/$c.crt" "/etc/kubernetes/pki/$c.key"
done
log "✓ Certificate authorities and service-account keys restored"

# ── 2. kubeadm configuration from the backup ─────────────────────────────────
progress 20 "Preparing the kubeadm configuration"
CC=$(awk '/^  ClusterConfiguration: \|/{f=1; next} f && /^  [^ ]/{f=0} f{sub(/^    /,""); print}' "$R/kubeadm-config.yaml" 2>/dev/null)
grep -q 'kind: ClusterConfiguration' <<< "$CC" || fail NO_CONFIG "The backup has no kubeadm ClusterConfiguration" "Use a backup taken by KubeEZ (offsite bundles include it)."
API=$(grep -m1 '^apiVersion:' <<< "$CC" | awk '{print $2}')
# kubernetesVersion → the installed patch (kubeadm refuses an older one)
CC=$(sed -E "s/^kubernetesVersion: .*/kubernetesVersion: ${KVER}/" <<< "$CC")
cat > /tmp/kubeez-recover.yaml <<EOF
apiVersion: $API
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: $IP
  bindPort: 6443
nodeRegistration:
  criSocket: unix:///var/run/containerd/containerd.sock
  imagePullPolicy: IfNotPresent
  name: $NAME
---
$CC
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
EOF

# ── 3. etcd data from the snapshot, with this machine as its only member ─────
progress 35 "Restoring etcd from the snapshot"
ETCD_IMG=$(kubeadm config images list --config /tmp/kubeez-recover.yaml 2>/dev/null | grep '/etcd:' | head -1)
[ -n "$ETCD_IMG" ] || fail NO_CONFIG "kubeadm could not read the recovered configuration" "$(kubeadm config images list --config /tmp/kubeez-recover.yaml 2>&1 | tail -1)"
log "Pulling $ETCD_IMG..."
crictl pull "$ETCD_IMG" >/dev/null 2>&1 || fail IMAGE_PULL_FAILED "Could not pull $ETCD_IMG" "Check this machine's internet access / registry mirror."
rm -rf /var/lib/etcd
CTR=(ctr -n k8s.io run --rm --mount type=bind,src=/var/lib,dst=/var/lib,options=rbind:rw "$ETCD_IMG")
BUMP=""
"${CTR[@]}" "kubeez-recover-help-$$" etcdutl snapshot restore --help 2>&1 | grep -q -- '--bump-revision' \
    && BUMP="--bump-revision 1000000000 --mark-compacted"
# shellcheck disable=SC2086
OUT=$("${CTR[@]}" "kubeez-recover-$$" etcdutl snapshot restore "$R/etcd-snapshot.db" --data-dir /var/lib/etcd \
    --name "$NAME" --initial-cluster "$NAME=https://$IP:2380" --initial-advertise-peer-urls "https://$IP:2380" $BUMP 2>&1) \
    || fail ETCD_RESTORE_FAILED "etcd could not restore the snapshot: $(tail -1 <<< "$OUT")" "The snapshot may be damaged — try an older offsite backup."
chown -R root:root /var/lib/etcd
log "✓ etcd data restored"

# ── 4. kubeadm builds the control plane around the restored data ─────────────
progress 50 "Starting the control plane (kubeadm init)"
IGNORE="DirAvailable--var-lib-etcd,NumCPU,Mem"
[ "$(uname -r | cut -d. -f1)" -lt 4 ] && IGNORE="$IGNORE,SystemVerification"
kubeadm init --config /tmp/kubeez-recover.yaml --ignore-preflight-errors="$IGNORE" > /tmp/kubeez-recover-init.log 2>&1 \
    || fail INIT_FAILED "kubeadm init failed: $(grep -iE 'error|fatal' /tmp/kubeez-recover-init.log | tail -2 | tr '\n' ' ')" "Full log on the node: /tmp/kubeez-recover-init.log"
export KUBECONFIG=$KC
mkdir -p "$HOME/.kube" && cp -f $KC "$HOME/.kube/config"
log "✓ Control plane started on the restored data"

progress 75 "Waiting for the cluster"
for _ in $(seq 1 60); do [ "$(kubectl get --raw=/readyz 2>/dev/null)" = ok ] && break; sleep 5; done
[ "$(kubectl get --raw=/readyz 2>/dev/null)" = ok ] || fail API_NOT_READY "The API server did not become ready" "Check 'crictl ps -a' on this machine."

# The lost machine's node object, if this one got a different name
OLD=$(sed -n 's/^node: *//p' "$R/MANIFEST" 2>/dev/null | tr 'A-Z' 'a-z')
if [ -n "$OLD" ] && [ "$OLD" != "$NAME" ] && kubectl get node "$OLD" >/dev/null 2>&1; then
    kubectl delete node "$OLD" --wait=false >/dev/null 2>&1 && log "Removed the old node object $OLD (this machine is $NAME)"
fi
# Same as a fresh install: control-plane may run workloads, join data for scaling
kubectl taint nodes "$NAME" node-role.kubernetes.io/control-plane- >/dev/null 2>&1 || true
JOIN=$(kubeadm token create --print-join-command --ttl 24h 2>/dev/null)
[ -n "$JOIN" ] && echo "$JOIN" > /tmp/kubeadm-join-command.txt

for _ in $(seq 1 36); do kubectl get node "$NAME" --no-headers 2>/dev/null | grep -q ' Ready ' && break; sleep 5; done
log "Nodes: $(kubectl get nodes --no-headers 2>/dev/null | awk '{print $1"="$2}' | tr '\n' ' ')"
rm -rf "$R" /tmp/kubeez-recover.yaml
progress 100 "Control plane recovered"
echo "RECOVER_OK"
