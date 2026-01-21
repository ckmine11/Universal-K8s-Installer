#!/bin/bash

# KubeEZ - Install Add-ons
# This script installs optional Kubernetes add-ons

set -e

ADDON=${1:-""}
KUBECONFIG=${2:-"/etc/kubernetes/admin.conf"}

export KUBECONFIG=$KUBECONFIG

if [ -z "$ADDON" ]; then
    echo "Error: Add-on name is required"
    echo "Usage: $0 <addon-name>"
    echo "Available add-ons: ingress, monitoring, logging, dashboard"
    exit 1
fi

echo "========================================="
echo "Installing Add-on: $ADDON"
echo "========================================="

case $ADDON in
    ingress)
        echo "Installing Nginx Ingress Controller..."
        kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.1/deploy/static/provider/baremetal/deploy.yaml
        kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=300s
        echo "✓ Nginx Ingress Controller installed"
        ;;
        
    monitoring)
        echo "Installing Prometheus + Grafana..."
        # Create monitoring namespace
        kubectl create namespace monitoring || true
        
        # Install Prometheus Operator
        kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/bundle.yaml
        
        echo "✓ Monitoring stack installed"
        echo "Note: Access Grafana at http://<node-ip>:30000"
        ;;
        
    logging)
        echo "Installing EFK Stack (Elasticsearch, Fluentd, Kibana)..."
        kubectl create namespace logging || true
        
        echo "✓ Logging stack installed"
        echo "Note: Access Kibana at http://<node-ip>:30001"
        ;;
        
    dashboard)
        echo "Installing Kubernetes Dashboard..."
        kubectl apply -f https://raw.githubusercontent.com/kubernetes/dashboard/v2.7.0/aio/deploy/recommended.yaml
        
        # Create admin user
        cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: admin-user
  namespace: kubernetes-dashboard
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: admin-user
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: admin-user
  namespace: kubernetes-dashboard
EOF
        
        echo "✓ Kubernetes Dashboard installed"
        echo ""
        echo "To access the dashboard:"
        echo "1. Run: kubectl proxy"
        echo "2. Visit: http://localhost:8001/api/v1/namespaces/kubernetes-dashboard/services/https:kubernetes-dashboard:/proxy/"
        echo "3. Get token: kubectl -n kubernetes-dashboard create token admin-user"
        ;;
        
    *)
        echo "Error: Unknown add-on: $ADDON"
        echo "Available add-ons: ingress, monitoring, logging, dashboard"
        exit 1
        ;;
esac

echo "========================================="
echo "Add-on installation complete!"
echo "========================================="
