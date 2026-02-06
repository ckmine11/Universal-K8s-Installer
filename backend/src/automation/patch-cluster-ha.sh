#!/bin/bash
set -e

# =========================================
# Patch Existing Cluster for HA Support
# =========================================
# This script adds controlPlaneEndpoint to an existing single-master cluster
# to enable HA master joins
#
# Arguments:
#   $1: Master IP (current control plane IP)

MASTER_IP="$1"

if [ -z "$MASTER_IP" ]; then
    echo "Error: Master IP required"
    echo "Usage: $0 <master-ip>"
    exit 1
fi

echo "========================================="
echo "Patching Cluster for HA Support"
echo "Master IP: $MASTER_IP"
echo "========================================="

# 1. Check current cluster configuration
echo "Checking current cluster configuration..."
echo "========================================="
echo "CURRENT ConfigMap ClusterConfiguration:"
kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}'
echo ""
echo "========================================="

if kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' | grep -q "controlPlaneEndpoint"; then
    echo "✓ Cluster already has controlPlaneEndpoint configured"
    ALREADY_CONFIGURED=true
else
    echo "❌ Cluster missing controlPlaneEndpoint - will add it"
    ALREADY_CONFIGURED=false
fi

# 2. Update ConfigMap if needed
if [ "$ALREADY_CONFIGURED" = false ]; then
    echo "Backing up current kubeadm config..."
    kubectl -n kube-system get cm kubeadm-config -o yaml > /tmp/kubeadm-config-backup.yaml

    echo "Fetching current cluster configuration..."
    kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' > /tmp/cluster-config.yaml

    echo "Adding controlPlaneEndpoint to configuration..."
    if grep -q "kubernetesVersion:" /tmp/cluster-config.yaml; then
        # Detect indentation
        INDENT=$(grep "kubernetesVersion:" /tmp/cluster-config.yaml | grep -o "^ *")
        sed -i "/kubernetesVersion:/a ${INDENT}controlPlaneEndpoint: \"$MASTER_IP:6443\"" /tmp/cluster-config.yaml
    else
        echo "controlPlaneEndpoint: \"$MASTER_IP:6443\"" >> /tmp/cluster-config.yaml
    fi

    # Verify the edit
    if ! grep -q "controlPlaneEndpoint" /tmp/cluster-config.yaml; then
        echo "❌ Failed to add controlPlaneEndpoint to config file"
        exit 1
    fi

    echo "✓ controlPlaneEndpoint added to config file"
    echo "Updated configuration:"
    cat /tmp/cluster-config.yaml

    echo ""
    echo "Updating kubeadm-config ConfigMap..."
    
    # Create a proper JSON patch using jq if available, otherwise use manual escaping
    if command -v jq &> /dev/null; then
        # Use jq for reliable JSON escaping
        CONFIG_JSON=$(cat /tmp/cluster-config.yaml | jq -Rs .)
    else
        # Fallback: Manual escaping (less reliable but works without dependencies)
        # Escape backslashes, quotes, newlines, and other special characters
        CONFIG_JSON=$(cat /tmp/cluster-config.yaml | \
            sed 's/\\/\\\\/g' | \
            sed 's/"/\\"/g' | \
            sed ':a;N;$!ba;s/\n/\\n/g')
        CONFIG_JSON="\"$CONFIG_JSON\""
    fi
    
    # Apply the patch
    kubectl -n kube-system patch configmap kubeadm-config --type merge -p "{\"data\":{\"ClusterConfiguration\":$CONFIG_JSON}}"

    echo "Verifying ConfigMap update..."
    if kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' | grep -q "controlPlaneEndpoint"; then
        echo "✓ ConfigMap updated successfully"
        echo "========================================="
        echo "UPDATED ConfigMap ClusterConfiguration:"
        kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}'
        echo ""
        echo "========================================="
    else
        echo "❌ ConfigMap update verification failed"
        echo "========================================="
        echo "ConfigMap after failed update:"
        kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}'
        echo ""
        echo "========================================="
        exit 1
    fi

    # 3. Update the on-disk kubeadm config
    echo "Updating on-disk kubeadm configuration..."
    cat /tmp/cluster-config.yaml > /etc/kubernetes/kubeadm-config.yaml

    echo "✓ Cluster configuration updated for HA"
fi

# 2.5 Self-Healing: Fix Malformed etcd extraArgs (Array vs Map)
# This handles legacy/broken configs from previous failed installs
echo "Checking for malformed etcd configuration..."
kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' > /tmp/cluster-config-check.yaml

if grep -q "\- name: heartbeat-interval" /tmp/cluster-config-check.yaml; then
    echo "⚠️  Detected malformed etcd extraArgs (Array format). Applying fix..."
    
    # Backup
    cp /tmp/cluster-config-check.yaml /tmp/cluster-config-malformed.yaml
    
    # Fix using sed: Convert "- name: key \n value: val" -> "key: val"
    # We use a loop to handle multiple args if needed, but specifically targeting the known broken ones
    sed -i '/- name: heartbeat-interval/{N;s/- name: heartbeat-interval\n *value: /heartbeat-interval: /}' /tmp/cluster-config-check.yaml
    sed -i '/- name: election-timeout/{N;s/- name: election-timeout\n *value: /election-timeout: /}' /tmp/cluster-config-check.yaml
    
    echo "Verified fix in temp file:"
    grep "heartbeat-interval" /tmp/cluster-config-check.yaml
    
    # Apply Patch
    echo "Applying patched Key-Value configuration..."
    
    # JSON Escape logic (reused)
    if command -v jq &> /dev/null; then
        CONFIG_JSON=$(cat /tmp/cluster-config-check.yaml | jq -Rs .)
    else
        CONFIG_JSON=$(cat /tmp/cluster-config-check.yaml | \
            sed 's/\\/\\\\/g' | \
            sed 's/"/\\"/g' | \
            sed ':a;N;$!ba;s/\n/\\n/g')
        CONFIG_JSON="\"$CONFIG_JSON\""
    fi
    
    kubectl -n kube-system patch configmap kubeadm-config --type merge -p "{\"data\":{\"ClusterConfiguration\":$CONFIG_JSON}}"
    
    echo "✓ Fixed malformed etcd configuration"
    
    # Sync to disk
    cat /tmp/cluster-config-check.yaml > /etc/kubernetes/kubeadm-config.yaml
else
    echo "✓ etcd configuration is valid (Map format)"
fi

# 4. Upload certificates for HA masters to join
echo "Uploading certificates for HA masters..."
CERT_KEY=$(kubeadm init phase upload-certs --upload-certs 2>/dev/null | tail -1)
echo "$CERT_KEY" > /tmp/kubeadm-cert-key.txt
echo "Certificate Key: $CERT_KEY"

# 5. Generate new join command
echo "Generating join command for HA masters..."
JOIN_COMMAND=$(kubeadm token create --print-join-command 2>/dev/null)
echo "$JOIN_COMMAND" > /tmp/kubeadm-join-command.txt
echo "Join Command: $JOIN_COMMAND"

echo ""
echo "========================================="
echo "✓ Cluster patched successfully!"
echo "========================================="
echo ""
echo "To join additional masters, use:"
echo "$JOIN_COMMAND --control-plane --certificate-key $CERT_KEY"
echo ""
echo "Certificate key expires in 2 hours."
echo "========================================="

# Return the cert key for automation
echo "$CERT_KEY"
