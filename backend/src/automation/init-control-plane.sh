#!/bin/bash

# KubeEZ - Initialize Kubernetes Control Plane
# This script initializes the Kubernetes control plane using kubeadm

set -e

MASTER_IP=${1:-""}
POD_NETWORK_CIDR=${2:-"10.244.0.0/16"}
K8S_VERSION=${3:-"1.28.0"}

if [ -z "$MASTER_IP" ]; then
    echo "Error: Master IP address is required"
    echo "Usage: $0 <master-ip> [pod-network-cidr] [k8s-version]"
    exit 1
fi

echo "========================================="
echo "Initializing Kubernetes Control Plane"
echo "========================================="
echo "Master IP: $MASTER_IP"
echo "Pod Network CIDR: $POD_NETWORK_CIDR"
echo "Kubernetes Version: v$K8S_VERSION"
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
fi

# 2. Determine Kubeadm API Version
KUBEADM_API_VERSION="kubeadm.k8s.io/v1beta3"
# Extract major and minor version for comparison (e.g., 1.35.0 -> 135)
VER_NUM=$(echo $K8S_VERSION | awk -F. '{printf "%d%02d", $1,$2}')

if [ "$VER_NUM" -ge "131" ]; then
    echo "Directed Kubeadm to use v1beta4 API (K8s >= 1.31 detected)"
    KUBEADM_API_VERSION="kubeadm.k8s.io/v1beta4"
else
    echo "Directed Kubeadm to use v1beta3 API (K8s < 1.31 detected)"
fi

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
controlPlaneEndpoint: "$MASTER_IP:6443"
networking:
  podSubnet: $POD_NETWORK_CIDR
etcd:
  local:
    extraArgs:
$(if [ "$KUBEADM_API_VERSION" = "kubeadm.k8s.io/v1beta4" ]; then
cat <<EOF2
    - name: heartbeat-interval
      value: "250"
    - name: election-timeout
      value: "2500"
EOF2
else
cat <<EOF2
      heartbeat-interval: "250"
      election-timeout: "2500"
EOF2
fi)
---
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
serverTLSBootstrap: true
EOF

# 3. Initialize Control Plane (HA-Ready)
if [ -f /etc/kubernetes/admin.conf ] && kubectl get nodes &> /dev/null; then
    echo "Skipping kubeadm init on existing Control Plane..."
else
    echo "Running HA-ready kubeadm init..."
    # Removed FileContent--proc-sys-net-bridge-bridge-nf-call-iptables from ignore list as we settled it in system prep
    kubeadm init --config /tmp/kubeadm-config.yaml --upload-certs --ignore-preflight-errors=NumCPU,Mem
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
