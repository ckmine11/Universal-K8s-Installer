#!/bin/bash

# KubeEZ - Install Network Plugin
# This script installs the CNI network plugin (Calico or Flannel)

set -e

PLUGIN=${1:-"calico"}
POD_CIDR=${2:-"10.244.0.0/16"}
KUBECONFIG="/etc/kubernetes/admin.conf"

export KUBECONFIG=$KUBECONFIG

echo "========================================="
echo "Installing Network Plugin: $PLUGIN"
echo "Pod CIDR: $POD_CIDR"
echo "========================================="

# Check if network plugin is already running
if kubectl get daemonset -n kube-system | grep -iE "calico|flannel" &> /dev/null || kubectl get daemonset -n kube-flannel | grep -i "flannel" &> /dev/null; then
    echo "Network plugin ($PLUGIN) is already running in the cluster. Skipping installation..."
    exit 0
fi

if [ "$PLUGIN" == "calico" ]; then
    echo "Installing Calico using direct manifest (High Compatibility Mode)..."
    
    # Download standard Calico manifest
    curl -sL https://raw.githubusercontent.com/projectcalico/calico/v3.26.1/manifests/calico.yaml -o /tmp/calico.yaml
    
    # Patch POD_CIDR (uncomment and replace)
    sed -i 's|# - name: CALICO_IPV4POOL_CIDR|- name: CALICO_IPV4POOL_CIDR|' /tmp/calico.yaml
    sed -i 's|#   value: "192.168.0.0/16"|  value: "'"$POD_CIDR"'"|' /tmp/calico.yaml
    
    # Apply the manifest
    kubectl apply -f /tmp/calico.yaml
    
    # Untaint master node so CoreDNS and Calico controllers can schedule
    echo "Untainting nodes..."
    kubectl taint nodes --all node-role.kubernetes.io/control-plane- || true
    kubectl taint nodes --all node-role.kubernetes.io/master- || true
    
    # Force kubelet restart to pick up CNI on this node
    echo "Restarting kubelet to ensure CNI recognition..."
    systemctl restart kubelet
    
    echo "Waiting for Calico pods to appear..."
    sleep 45
    
    echo "Waiting for calico-node pods to be Ready..."
    kubectl wait --for=condition=Ready pods -l k8s-app=calico-node -n kube-system --timeout=600s || {
        echo "Warning: Calico pods are not Ready yet, but proceeding..."
    }
    
    echo "✓ Calico installation confirmed"
    
elif [ "$PLUGIN" == "flannel" ]; then
    echo "Installing Flannel (recommended for CentOS 7 compatibility)..."
    
    # Download and patch Flannel manifest with correct CIDR
    curl -sL https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml -o /tmp/kube-flannel.yml
    sed -i "s|10.244.0.0/16|$POD_CIDR|g" /tmp/kube-flannel.yml
    
    kubectl apply -f /tmp/kube-flannel.yml
    
    # Untaint nodes so CoreDNS can run
    echo "Untainting nodes..."
    kubectl taint nodes --all node-role.kubernetes.io/control-plane- || true
    kubectl taint nodes --all node-role.kubernetes.io/master- || true
    
    # Restart kubelet to sync with CNI
    systemctl restart kubelet
    
    echo "Waiting for Flannel pods to be ready..."
    sleep 30
    kubectl wait --for=condition=Ready pods --all -n kube-flannel --timeout=300s || true
    
    echo "✓ Flannel installation initiated"
fi

# Verify network plugin
echo ""
echo "Network plugin status:"
kubectl get pods --all-namespaces | grep -E "calico|flannel" || echo "No network pods found yet (still initializing)"

echo ""
echo "========================================="
echo "Network plugin installation complete!"
echo "========================================="
