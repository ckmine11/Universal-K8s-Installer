#!/bin/bash

# KubeEZ - Initialize Kubernetes Control Plane
# This script initializes the Kubernetes control plane using kubeadm

set -e

MASTER_IP=${1:-""}
POD_NETWORK_CIDR=${2:-"10.244.0.0/16"}
K8S_VERSION=${3:-"1.28.0"}
# Optional: a free IP on the control-plane network that floats between the
# control-planes (kube-vip). Without it the API endpoint is this node's IP.
VIP=${4:-""}

if [ -z "$MASTER_IP" ]; then
    echo "Error: Master IP address is required"
    echo "Usage: $0 <master-ip> [pod-network-cidr] [k8s-version] [control-plane-vip]"
    exit 1
fi

# CRITICAL: pin the control-plane version to the ACTUALLY INSTALLED kubeadm.
# install-kubernetes.sh installs the latest patch of the chosen minor (e.g. the
# repo may ship 1.37.1 while the wizard requested 1.37.0). If kubeadm-config says
# v1.37.0 but the binaries are 1.37.1, kubeadm init hits a version-mismatch
# preflight error. Using the installed version keeps everything consistent and
# always pulls images that exist.
DETECTED_VER=$(kubeadm version -o short 2>/dev/null | sed 's/^v//')
if [ -n "$DETECTED_VER" ]; then
    echo "Detected installed kubeadm: v$DETECTED_VER (requested: v$K8S_VERSION)"
    K8S_VERSION="$DETECTED_VER"
fi

# kube-vip: a floating virtual IP (VIP) for the Kubernetes API, held by one
# healthy control-plane at a time (ARP + leader election). Runs as a static pod.
# write_kube_vip <vip> <node-ip> <kubeconfig-on-host>
KUBE_VIP_IMAGE="ghcr.io/kube-vip/kube-vip:v1.2.4"
write_kube_vip() {
    local vip="$1" node_ip="$2" kubeconfig="$3" iface
    iface=$(ip -o -4 addr show | awk -v ip="$node_ip" '{split($4, a, "/"); if (a[1] == ip) {print $2; exit}}')
    if [ -z "$iface" ]; then
        echo "KUBEEZ_FAIL|VIP_NO_INTERFACE|No network interface on this node has the address $node_ip.|Use the node's own LAN address for this control-plane."
        exit 1
    fi
    echo "kube-vip: VIP $vip on interface $iface (node $node_ip)"
    crictl --runtime-endpoint unix:///var/run/containerd/containerd.sock pull "$KUBE_VIP_IMAGE" >/dev/null 2>&1 \
        || ctr -n k8s.io images pull "$KUBE_VIP_IMAGE" >/dev/null 2>&1 \
        || echo "warning: could not pre-pull $KUBE_VIP_IMAGE — the kubelet will try again"
    mkdir -p /etc/kubernetes/manifests
    cat > /etc/kubernetes/manifests/kube-vip.yaml <<KVEOF
apiVersion: v1
kind: Pod
metadata:
  name: kube-vip
  namespace: kube-system
  labels:
    app.kubernetes.io/managed-by: kubeez
spec:
  containers:
  - args:
    - manager
    env:
    - name: vip_arp
      value: "true"
    - name: port
      value: "6443"
    - name: vip_nodename
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: vip_interface
      value: $iface
    - name: vip_subnet
      value: "32"
    - name: dns_mode
      value: first
    - name: cp_enable
      value: "true"
    - name: cp_namespace
      value: kube-system
    - name: vip_leaderelection
      value: "true"
    - name: vip_leasename
      value: plndr-cp-lock
    - name: vip_leaseduration
      value: "15"
    - name: vip_renewdeadline
      value: "10"
    - name: vip_retryperiod
      value: "2"
    - name: address
      value: "$vip"
    image: $KUBE_VIP_IMAGE
    imagePullPolicy: IfNotPresent
    name: kube-vip
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
        drop:
        - ALL
    volumeMounts:
    - mountPath: /etc/kubernetes/admin.conf
      name: kubeconfig
  hostAliases:
  - hostnames:
    - kubernetes
    ip: 127.0.0.1
  hostNetwork: true
  priorityClassName: system-node-critical
  volumes:
  - hostPath:
      path: $kubeconfig
    name: kubeconfig
KVEOF
    chmod 600 /etc/kubernetes/manifests/kube-vip.yaml
}

ENDPOINT="$MASTER_IP"
if [ -n "$VIP" ]; then
    if [ "$VIP" = "$MASTER_IP" ]; then
        echo "KUBEEZ_FAIL|VIP_IS_NODE|The virtual IP $VIP is this node's own address.|Pick a free address on the same network that no machine uses."
        exit 1
    fi
    ENDPOINT="$VIP"
fi

echo "========================================="
echo "Initializing Kubernetes Control Plane"
echo "========================================="
echo "Master IP: $MASTER_IP"
echo "Pod Network CIDR: $POD_NETWORK_CIDR"
echo "Kubernetes Version: v$K8S_VERSION"
[ -n "$VIP" ] && echo "API endpoint (VIP): $VIP:6443"
echo "========================================="

# 1. Smart Check: Is this node already an initialized Control Plane?
if [ -f /etc/kubernetes/admin.conf ] && kubectl get nodes &> /dev/null; then
    echo "This node is already an active Control Plane. Skipping initialization..."
    echo "Ensuring configurations are up to date..."
else
    echo "Performing Deep Clean (Control Plane Initialization)..."
    # 1. Aggressive Deep Clean (Port Massacre)
    kubeadm reset -f || true
    systemctl stop kubelet containerd || true

    # Kill anything on K8s ports to fix "Port in use"
    for port in 6443 2379 2380 10250 10259 10257; do
        fuser -k "$port/tcp" || true
    done
    sleep 5

    # Wipe data directories
    rm -rf /etc/cni/net.d/* /var/lib/cni/* /var/lib/etcd/* /var/lib/kubelet/* /etc/kubernetes/manifests/* $HOME/.kube
    iptables -F && iptables -t nat -F && iptables -t mangle -F && iptables -X

    systemctl start containerd

    if [ -n "$VIP" ]; then
        # A previous attempt's kube-vip may have left the VIP on this node
        ip -o -4 addr show | awk -v v="$VIP" '{split($4, a, "/"); if (a[1] == v) print $2}' | while read -r dev; do
            ip addr del "$VIP/32" dev "$dev" 2>/dev/null || true
        done
        # The VIP must be free before kube-vip claims it
        if ping -c 1 -W 1 "$VIP" >/dev/null 2>&1; then
            echo "KUBEEZ_FAIL|VIP_IN_USE|The virtual IP $VIP already answers on the network.|Pick a free address on the control-plane network (not a node, not in a DHCP range)."
            exit 1
        fi
        # From 1.29, admin.conf only gets its rights after init — kube-vip uses
        # super-admin.conf until then, and admin.conf afterwards.
        if [ "$(echo "$K8S_VERSION" | cut -d. -f2)" -ge 29 ]; then
            write_kube_vip "$VIP" "$MASTER_IP" /etc/kubernetes/super-admin.conf
        else
            write_kube_vip "$VIP" "$MASTER_IP" /etc/kubernetes/admin.conf
        fi
    fi
fi

# 2. Pick the kubeadm config API for the INSTALLED kubeadm:
#   v1beta4 → kubeadm 1.31+ (REQUIRED from 1.37, which removed v1beta3)
#   v1beta3 → kubeadm 1.22 – 1.30
# v1beta4 also changed extraArgs from a map to a list of {name, value}.
KUBEADM_MINOR=$(kubeadm version -o short 2>/dev/null | sed 's/^v//' | cut -d. -f2)
if [ "${KUBEADM_MINOR:-0}" -ge 31 ]; then
    KUBEADM_API_VERSION="kubeadm.k8s.io/v1beta4"
    ETCD_EXTRA_ARGS='    extraArgs:
    - name: heartbeat-interval
      value: "250"
    - name: election-timeout
      value: "2500"'
else
    KUBEADM_API_VERSION="kubeadm.k8s.io/v1beta3"
    ETCD_EXTRA_ARGS='    extraArgs:
      heartbeat-interval: "250"
      election-timeout: "2500"'
fi
echo "Using kubeadm config API ${KUBEADM_API_VERSION} (kubeadm v1.${KUBEADM_MINOR:-?})"

echo "Creating Kubeadm Configuration..."
cat <<EOF > /tmp/kubeadm-config.yaml
apiVersion: $KUBEADM_API_VERSION
kind: InitConfiguration
localAPIEndpoint:
  advertiseAddress: $MASTER_IP
  bindPort: 6443
nodeRegistration:
  criSocket: unix:///var/run/containerd/containerd.sock
  imagePullPolicy: IfNotPresent
  name: $(hostname)
---
apiVersion: $KUBEADM_API_VERSION
kind: ClusterConfiguration
kubernetesVersion: v$K8S_VERSION
controlPlaneEndpoint: "$ENDPOINT:6443"
apiServer:
  certSANs:
  - "$MASTER_IP"
  - "$ENDPOINT"
networking:
  podSubnet: $POD_NETWORK_CIDR
etcd:
  local:
$ETCD_EXTRA_ARGS
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
EOF
# NOTE: serverTLSBootstrap is deliberately NOT enabled. With it, every kubelet
# waits for a manually approved serving-cert CSR, and until then
# 'kubectl logs/exec' fail with "tls: internal error" (and again on every
# yearly cert rotation). kubeadm's default self-signed serving cert just works.

# 3. Initialize Control Plane (HA-Ready)
if [ -f /etc/kubernetes/admin.conf ] && kubectl get nodes &> /dev/null; then
    echo "Skipping kubeadm init on existing Control Plane..."
else
    echo "Running HA-ready kubeadm init..."
    
    # FIX: Check for Legacy Kernel (Kernel < 4.x) and ignore SystemVerification globally
    KERNEL_MAJOR=$(uname -r | cut -d. -f1)
    IGNORE_FLAGS="--ignore-preflight-errors=NumCPU,Mem"
    # kube-vip's static pod is already in the manifests folder
    [ -n "$VIP" ] && IGNORE_FLAGS="${IGNORE_FLAGS},DirAvailable--etc-kubernetes-manifests"
    if [ "$KERNEL_MAJOR" -lt 4 ]; then
        echo "⚠️ Warning: Legacy Kernel detected ($(uname -r)). Bypassing SystemVerification check."
        IGNORE_FLAGS="${IGNORE_FLAGS},SystemVerification"
    fi

    # Removed FileContent--proc-sys-net-bridge-bridge-nf-call-iptables from ignore list as we settled it in system prep
    kubeadm init --config /tmp/kubeadm-config.yaml --upload-certs $IGNORE_FLAGS

    # Back from super-admin.conf to admin.conf (has its rights now)
    if [ -n "$VIP" ] && grep -q super-admin.conf /etc/kubernetes/manifests/kube-vip.yaml 2>/dev/null; then
        sed -i 's#path: /etc/kubernetes/super-admin.conf#path: /etc/kubernetes/admin.conf#' /etc/kubernetes/manifests/kube-vip.yaml
    fi
fi

# 4. Setup kubeconfig
mkdir -p $HOME/.kube
cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
chown $(id -u):$(id -g) $HOME/.kube/config

# Persistence for root
if ! grep -q "KUBECONFIG" $HOME/.bashrc; then
    echo "export KUBECONFIG=/etc/kubernetes/admin.conf" >> $HOME/.bashrc
fi
export KUBECONFIG=/etc/kubernetes/admin.conf

# 5. Untaint Master immediately for CoreDNS
kubectl taint nodes --all node-role.kubernetes.io/control-plane- || true
kubectl taint nodes --all node-role.kubernetes.io/master- || true

# Wait for API server to propagate cluster-info
echo "Waiting 30 seconds for cluster-info to propagate..."
sleep 30

# Generate join command and certificate key with long TTL
echo "Updating join data for cluster scaling..."
JOIN_COMMAND=$(kubeadm token create --print-join-command --ttl 24h)
# Generate a fresh certificate key (Idempotent: uploads certs to the cluster secrets)
CERT_KEY=$(kubeadm init phase upload-certs --upload-certs | grep -v 'upload-certs' | tail -n 1)

echo "$JOIN_COMMAND" > /tmp/kubeadm-join-command.txt
echo "$CERT_KEY" > /tmp/kubeadm-cert-key.txt

echo "JOIN_COMMAND=$JOIN_COMMAND"
echo "CERT_KEY=$CERT_KEY"
