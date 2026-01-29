#!/bin/bash

# KubeEZ - Join Worker Node
# This script joins a worker node to the Kubernetes cluster

set -e

# Capture arguments
JOIN_COMMAND="$1"
NODE_TYPE="${2:-worker}"  # master or worker
CERT_KEY="$3"            # only for master join

if [ -z "$JOIN_COMMAND" ]; then
    echo "Error: Join command is required"
    exit 1
fi

echo "========================================="
echo "Joining Worker Node to Cluster"
echo "========================================="

# Smart Check: Is this node already part of the cluster?
if [ -f /etc/kubernetes/kubelet.conf ] && systemctl is-active --quiet kubelet; then
    echo "This node is already active in the cluster. Skipping join..."
else
    # Clean up previous attempts
    echo "Cleaning up worker node and killing port usage..."
    systemctl stop kubelet || true
    kubeadm reset -f || true

    for port in 10250 10255 10259 10257; do
        fuser -k "$port/tcp" || true
    done

    rm -rf /etc/cni/net.d/* /var/lib/cni/* /var/lib/kubelet/* || true
    ip link delete cni0 || true
    ip link delete flannel.1 || true
fi

# Execute join command
if [ -z "$JOIN_COMMAND" ]; then
    echo "Error: JOIN_COMMAND variable is empty!"
    exit 1
fi
# Execute join command
if [ -f /etc/kubernetes/kubelet.conf ] && systemctl is-active --quiet kubelet; then
    echo "Skipping join command execution..."
else
    echo "Executing join command for $NODE_TYPE node..."
    conntrack -F || true
    sleep 5

    # FIX: Check for Legacy Kernel (Kernel < 4.x) and ignore SystemVerification globally
    KERNEL_MAJOR=$(uname -r | cut -d. -f1)
    IGNORE_FLAGS="--ignore-preflight-errors=NumCPU,Mem"
    
    if [ "$KERNEL_MAJOR" -lt 4 ]; then
        echo "⚠️ Warning: Legacy Kernel detected ($(uname -r)). Bypassing SystemVerification check for Universal Compatibility."
        IGNORE_FLAGS="${IGNORE_FLAGS},SystemVerification"
    fi

    if [ "$NODE_TYPE" == "master" ]; then
        echo "Joining as Additional Control Plane..."
        eval "$JOIN_COMMAND --control-plane --certificate-key $CERT_KEY $IGNORE_FLAGS"
    else
        echo "Joining as Worker Node..."
        eval "$JOIN_COMMAND $IGNORE_FLAGS"
    fi
fi

# Verify & Setup Kubectl for Masters
if [ "$NODE_TYPE" == "master" ]; then
    echo "Setting up kubectl on Master node..."
    mkdir -p $HOME/.kube
    cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
    chown $(id -u):$(id -g) $HOME/.kube/config
    
    if ! grep -q "KUBECONFIG" $HOME/.bashrc; then
        echo "export KUBECONFIG=/etc/kubernetes/admin.conf" >> $HOME/.bashrc
    fi
    export KUBECONFIG=/etc/kubernetes/admin.conf
fi

echo "✓ $NODE_TYPE node join process completed"
echo "========================================="
if [ "$NODE_TYPE" == "master" ]; then
    echo "You can now run 'kubectl get nodes' on this machine."
fi
echo "========================================="
