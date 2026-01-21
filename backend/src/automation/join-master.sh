#!/bin/bash
set -e

# =========================================
# Join Additional Control Plane Node
# =========================================
# This script joins a new node to an existing Kubernetes cluster as an additional control plane (HA master)
# Arguments:
#   $1: Join command (from kubeadm token create)
#   $2: Certificate key (for control plane join)

JOIN_COMMAND="$1"
CERT_KEY="$2"

echo "========================================="
echo "Joining as Additional Control Plane..."
echo "========================================="

# Clean up any previous cluster state
echo "Cleaning up control plane node and killing port usage..."
kubeadm reset -f 2>/dev/null || true
systemctl stop kubelet 2>/dev/null || true
rm -rf /etc/kubernetes/* /var/lib/etcd/* /var/lib/kubelet/* 2>/dev/null || true
rm -rf /etc/cni/net.d/* 2>/dev/null || true
ip link delete cni0 2>/dev/null || true
ip link delete flannel.1 2>/dev/null || true
iptables -F && iptables -t nat -F && iptables -t mangle -F && iptables -X 2>/dev/null || true
conntrack -F 2>/dev/null || true

# Execute join command with control-plane flag
echo "Executing join command for control plane..."
# Ensure join command is not empty
if [ -z "$JOIN_COMMAND" ]; then
    echo "Error: JOIN_COMMAND is empty"
    exit 1
fi

$JOIN_COMMAND --control-plane --certificate-key $CERT_KEY --ignore-preflight-errors=NumCPU,Mem

# Wait for kubelet to start
echo "Waiting for kubelet to start..."
sleep 5

# Configure kubectl for this master node
echo "Configuring kubectl..."
mkdir -p $HOME/.kube
cp -f /etc/kubernetes/admin.conf $HOME/.kube/config
chown $(id -u):$(id -g) $HOME/.kube/config

# Verify node joined successfully
echo "Verifying control plane node status..."
kubectl get nodes

echo "✓ Control plane node joined successfully"
