#!/bin/bash

# KubeEZ - Install cert-manager
# Automatic TLS certificate management for Kubernetes

set -e

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG=$KUBECONFIG

echo "========================================="
echo "Installing cert-manager"
echo "========================================="

# 1. Create namespace
echo "Step 1/3: Creating namespace..."
kubectl create namespace cert-manager --dry-run=client -o yaml | kubectl apply -f -

# 2. Install cert-manager CRDs and controller
echo "Step 2/3: Installing cert-manager..."
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.3/cert-manager.yaml

# 3. Wait for cert-manager to be ready
echo "Step 3/3: Waiting for cert-manager to be ready..."
kubectl rollout status deployment/cert-manager -n cert-manager --timeout=300s
kubectl rollout status deployment/cert-manager-webhook -n cert-manager --timeout=300s
kubectl rollout status deployment/cert-manager-cainjector -n cert-manager --timeout=300s

# 4. Create a self-signed ClusterIssuer for testing
echo "Creating self-signed ClusterIssuer..."
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-issuer
spec:
  selfSigned: {}
EOF

# 5. Optionally create Let's Encrypt staging issuer (commented out - requires email)
cat <<EOF > /tmp/letsencrypt-staging.yaml
# Uncomment and configure this for Let's Encrypt staging certificates
# apiVersion: cert-manager.io/v1
# kind: ClusterIssuer
# metadata:
#   name: letsencrypt-staging
# spec:
#   acme:
#     server: https://acme-staging-v02.api.letsencrypt.org/directory
#     email: your-email@example.com  # CHANGE THIS
#     privateKeySecretRef:
#       name: letsencrypt-staging
#     solvers:
#     - http01:
#         ingress:
#           class: nginx
EOF

echo "✓ cert-manager installed successfully"
echo ""
echo "Verify installation:"
echo "  kubectl get pods -n cert-manager"
echo "  kubectl get clusterissuers"
echo ""
echo "Example Certificate:"
echo "  apiVersion: cert-manager.io/v1"
echo "  kind: Certificate"
echo "  metadata:"
echo "    name: example-cert"
echo "    namespace: default"
echo "  spec:"
echo "    secretName: example-tls"
echo "    issuerRef:"
echo "      name: selfsigned-issuer"
echo "      kind: ClusterIssuer"
echo "    dnsNames:"
echo "    - example.com"
echo ""
echo "For Let's Encrypt, edit /tmp/letsencrypt-staging.yaml and apply it"

echo "========================================="
echo "cert-manager installation complete!"
echo "========================================="
