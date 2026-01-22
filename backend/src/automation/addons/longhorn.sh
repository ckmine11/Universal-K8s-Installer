#!/bin/bash

# KubeEZ - Install Longhorn Storage
# Cloud-native distributed block storage for Kubernetes

set -e

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG=$KUBECONFIG

echo "========================================="
echo "Installing Longhorn Storage"
echo "========================================="

# 1. Check prerequisites
echo "Checking prerequisites..."
echo "  - open-iscsi should be installed on all nodes"
echo "  - Each node should have at least 10GB free disk space"

# 2. Create namespace
echo "Step 1/4: Creating namespace..."
kubectl create namespace longhorn-system --dry-run=client -o yaml | kubectl apply -f -

# 3. Install Longhorn
echo "Step 2/4: Installing Longhorn..."
kubectl apply -f https://raw.githubusercontent.com/longhorn/longhorn/v1.5.3/deploy/longhorn.yaml

# 4. Wait for Longhorn to be ready
echo "Step 3/4: Waiting for Longhorn components..."
sleep 30  # Give it time to create resources

echo "Waiting for Longhorn manager..."
kubectl wait --for=condition=Available deployment/longhorn-driver-deployer -n longhorn-system --timeout=300s || echo "Warning: Timeout waiting for driver deployer"

# 5. Create NodePort service for Longhorn UI
echo "Step 4/4: Exposing Longhorn UI..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: longhorn-frontend-nodeport
  namespace: longhorn-system
spec:
  type: NodePort
  selector:
    app: longhorn-ui
  ports:
  - port: 80
    targetPort: 8000
    nodePort: 30080
    name: http
EOF

# 6. Set Longhorn as default StorageClass (optional)
echo "Setting Longhorn as default StorageClass..."
kubectl patch storageclass longhorn -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

echo "✓ Longhorn installed successfully"
echo ""
echo "Access Longhorn UI:"
echo "  http://<node-ip>:30080"
echo ""
echo "Verify installation:"
echo "  kubectl get pods -n longhorn-system"
echo "  kubectl get storageclass"
echo ""
echo "Create a PVC example:"
echo "  apiVersion: v1"
echo "  kind: PersistentVolumeClaim"
echo "  metadata:"
echo "    name: longhorn-pvc"
echo "  spec:"
echo "    accessModes:"
echo "    - ReadWriteOnce"
echo "    storageClassName: longhorn"
echo "    resources:"
echo "      requests:"
echo "        storage: 5Gi"
echo ""
echo "⚠️  Note: Ensure open-iscsi is installed on all nodes:"
echo "  Ubuntu/Debian: sudo apt-get install open-iscsi"
echo "  CentOS/RHEL: sudo yum install iscsi-initiator-utils"

echo "========================================="
echo "Longhorn installation complete!"
echo "========================================="
