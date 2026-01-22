#!/bin/bash

# KubeEZ - Install ArgoCD
# GitOps continuous delivery tool for Kubernetes

set -e

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG=$KUBECONFIG

echo "========================================="
echo "Installing ArgoCD"
echo "========================================="

# 1. Create namespace
echo "Step 1/4: Creating namespace..."
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -

# 2. Install ArgoCD
echo "Step 2/4: Installing ArgoCD..."
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 3. Wait for ArgoCD to be ready
echo "Step 3/4: Waiting for ArgoCD components..."
kubectl wait --for=condition=Available deployment/argocd-server -n argocd --timeout=300s
kubectl wait --for=condition=Available deployment/argocd-repo-server -n argocd --timeout=300s
kubectl wait --for=condition=Available deployment/argocd-dex-server -n argocd --timeout=300s

# 4. Expose ArgoCD server via NodePort
echo "Step 4/4: Exposing ArgoCD UI..."
kubectl patch svc argocd-server -n argocd -p '{"spec": {"type": "NodePort", "ports": [{"port": 443, "targetPort": 8080, "nodePort": 30443, "name": "https"}]}}'

# 5. Get initial admin password
echo ""
echo "✓ ArgoCD installed successfully"
echo ""
echo "========================================="
echo "ArgoCD Access Information"
echo "========================================="
echo ""
echo "UI Access:"
echo "  URL: https://<node-ip>:30443"
echo "  Username: admin"
echo ""
echo "Get initial password:"
echo "  kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d && echo"
echo ""
echo "Or use this command to retrieve it:"
INITIAL_PASSWORD=$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" 2>/dev/null | base64 -d 2>/dev/null || echo "Run the command above to get password")
if [ "$INITIAL_PASSWORD" != "Run the command above to get password" ]; then
    echo "  Password: $INITIAL_PASSWORD"
fi
echo ""
echo "Install ArgoCD CLI (optional):"
echo "  # Linux"
echo "  curl -sSL -o /usr/local/bin/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64"
echo "  chmod +x /usr/local/bin/argocd"
echo ""
echo "  # macOS"
echo "  brew install argocd"
echo ""
echo "Login via CLI:"
echo "  argocd login <node-ip>:30443 --username admin --password <password> --insecure"
echo ""
echo "Change admin password:"
echo "  argocd account update-password"
echo ""
echo "Verify installation:"
echo "  kubectl get pods -n argocd"
echo "  kubectl get svc -n argocd"
echo ""
echo "Example: Deploy an app from Git:"
echo "  argocd app create guestbook \\"
echo "    --repo https://github.com/argoproj/argocd-example-apps.git \\"
echo "    --path guestbook \\"
echo "    --dest-server https://kubernetes.default.svc \\"
echo "    --dest-namespace default"
echo ""
echo "  argocd app sync guestbook"

echo "========================================="
echo "ArgoCD installation complete!"
echo "========================================="
