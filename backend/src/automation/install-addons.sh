#!/bin/bash

# KubeEZ - Install Add-ons
# This script installs optional Kubernetes add-ons

set -e

ADDON=${1:-""}
KUBECONFIG=${2:-"/etc/kubernetes/admin.conf"}

export KUBECONFIG=$KUBECONFIG

# Cleanup function for temporary files
cleanup() {
    rm -f /tmp/bundle.yaml /tmp/bundle-monitoring.yaml /tmp/dashboard.json
}
trap cleanup EXIT

if [ -z "$ADDON" ]; then
    echo "Error: Add-on name is required"
    echo "Usage: $0 <addon-name>"
    echo "Available add-ons: ingress, monitoring, dashboard"
    exit 1

fi

# Approve any pending CSRs (Fixes 'tls: internal error' for logs/metrics)
echo "Ensuring Kubelet CSRs are approved..."
kubectl get csr -o go-template='{{range .items}}{{if not .status.certificate}}{{.metadata.name}}{{"\n"}}{{end}}{{end}}' | xargs -r kubectl certificate approve || true


echo "========================================="
echo "Installing Add-on: $ADDON"
echo "========================================="

case $ADDON in
    ingress)
        echo "Installing Nginx Ingress Controller..."
        kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.1/deploy/static/provider/baremetal/deploy.yaml
        kubectl rollout status deployment/ingress-nginx-controller -n ingress-nginx --timeout=300s
        echo "✓ Nginx Ingress Controller installed"
        ;;
        
    monitoring)
        echo "Installing Complete Monitoring Stack..."
        
        # 1. Namespace
        kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
        
        # 2. Operator
        echo "Step 1/5: Installing Prometheus Operator (in monitoring namespace)..."
        # Download bundle first
        curl -L https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/bundle.yaml -o /tmp/bundle.yaml
        
        # Force it into monitoring namespace to ensure it sees our CRs
        sed 's/namespace: default/namespace: monitoring/g' /tmp/bundle.yaml > /tmp/bundle-monitoring.yaml
        
        # Apply the modified bundle
        kubectl apply --server-side --force-conflicts -f /tmp/bundle-monitoring.yaml
        
        echo "Waiting for Operator to be ready..."
        if ! kubectl rollout status deployment/prometheus-operator -n monitoring --timeout=300s; then
            echo "Error: Prometheus Operator failed to become ready"
            exit 1
        fi

        # 3. Prometheus Instance & RBAC
        echo "Step 2/5: Configuring Prometheus Instance..."
        # SA & RBAC
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: prometheus
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: prometheus
rules:
- apiGroups: [""]
  resources: ["nodes", "nodes/metrics", "services", "endpoints", "pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get"]
- apiGroups: ["networking.k8s.io"]
  resources: ["ingresses"]
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/metrics"]
  verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: prometheus
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: prometheus
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
EOF
        
        # Prometheus CR
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: main
spec:
  serviceAccountName: prometheus
  serviceMonitorSelector: {}
  serviceMonitorNamespaceSelector: {}
  resources:
    requests:
      memory: 256Mi
      cpu: 200m
    limits:
      memory: 800Mi
      cpu: 500m
  enableAdminAPI: false
EOF

        # Prometheus Service (NodePort for easy access)
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: v1
kind: Service
metadata:
  name: prometheus-nodeport
  namespace: monitoring
spec:
  type: NodePort
  selector:
    prometheus: main
  ports:
  - name: web
    port: 9090
    targetPort: 9090
    nodePort: 30090
EOF

        echo "Waiting for Prometheus to be ready..."
        echo "Waiting for Prometheus to be ready..."
        if ! kubectl rollout status statefulset/prometheus-main -n monitoring --timeout=600s; then
            echo "Error: Prometheus failed to become ready"
            echo "--- DIAGNOSTIC INFO ---"
            echo "StatefulSet Details:"
            kubectl describe statefulset prometheus-main -n monitoring
            echo "Pod Events:"
            kubectl get events -n monitoring --sort-by='.lastTimestamp'
            echo "Pod Logs (if any):"
            kubectl logs -l app.kubernetes.io/name=prometheus -n monitoring --tail=20 --all-containers=true
            echo "-----------------------"
            exit 1
        fi

        # 4. Grafana
        echo "Step 3/5: Installing Grafana with Dashboards..."
        
        # Dashboard JSON (Simple Cluster Overview)
        cat <<EOF > /tmp/dashboard.json
{
  "annotations": { "list": [] },
  "editable": true,
  "gnetId": null,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [
    {
      "title": "Cluster CPU Usage",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "targets": [ { "expr": "sum(rate(node_cpu_seconds_total{mode!='idle'}[1m])) by (instance)", "legendFormat": "{{instance}}", "refId": "A" } ]
    },
    {
      "title": "Cluster Memory Usage",
      "type": "timeseries",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "targets": [ { "expr": "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes", "legendFormat": "{{instance}}", "refId": "A" } ]
    },
    {
        "title": "Active Pods",
        "type": "stat",
        "gridPos": { "h": 4, "w": 24, "x": 0, "y": 8 },
        "targets": [ { "expr": "sum(kube_pod_info)", "legendFormat": "Pods", "refId": "A" } ]
    }
  ],
  "refresh": "5s",
  "schemaVersion": 30,
  "style": "dark",
  "tags": [],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "",
  "title": "KubeEZ Cluster Overview",
  "uid": "kubeez-overview",
  "version": 1
}
EOF

        # ConfigMap: Datasource & Dashboard Provider
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-config
data:
  # 1. Datasource
  datasource.yaml: |-
    apiVersion: 1
    datasources:
    - name: Prometheus
      type: prometheus
      access: proxy
      url: http://prometheus-operated.monitoring.svc:9090
      isDefault: true
  
  # 2. Dashboard Provider
  dashboard-provider.yaml: |-
    apiVersion: 1
    providers:
    - name: 'default'
      orgId: 1
      folder: ''
      type: file
      disableDeletion: false
      editable: true
      options:
        path: /var/lib/grafana/dashboards
EOF

        # ConfigMap: The Dashboard JSON itself
        kubectl create configmap grafana-dashboards --from-file=kubeez-overview.json=/tmp/dashboard.json -n monitoring --dry-run=client -o yaml | kubectl apply -f -

        # Grafana Deployment (Updated with mounts and resource limits)
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grafana
spec:
  replicas: 1
  selector:
    matchLabels:
      app: grafana
  template:
    metadata:
      labels:
        app: grafana
    spec:
      containers:
      - name: grafana
        image: grafana/grafana:11.3.0
        ports:
        - containerPort: 3000
        resources:
          requests:
            memory: 128Mi
            cpu: 100m
          limits:
            memory: 256Mi
            cpu: 200m
        volumeMounts:
        - name: config
          mountPath: /etc/grafana/provisioning/datasources/datasource.yaml
          subPath: datasource.yaml
        - name: config
          mountPath: /etc/grafana/provisioning/dashboards/dashboard-provider.yaml
          subPath: dashboard-provider.yaml
        - name: dashboards
          mountPath: /var/lib/grafana/dashboards
      volumes:
      - name: config
        configMap:
          name: grafana-config
      - name: dashboards
        configMap:
          name: grafana-dashboards
---
apiVersion: v1
kind: Service
metadata:
  name: grafana
spec:
  type: NodePort
  selector:
    app: grafana
  ports:
  - port: 3000
    targetPort: 3000
    nodePort: 30000
EOF

        echo "Waiting for Grafana to be ready..."
        if ! kubectl rollout status deployment/grafana -n monitoring --timeout=300s; then
             echo "Error: Grafana failed to become ready"
             echo "--- DIAGNOSTIC INFO ---"
             kubectl get events -n monitoring --field-selector involvedObject.name=grafana
             kubectl logs deployment/grafana -n monitoring --tail=20
             echo "-----------------------"
             exit 1
        fi

        # 5. Node Exporter (The actual metrics source)
        echo "Step 4/5: Installing Node Exporter (Metrics Agent)..."
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      hostNetwork: true
      hostPID: true
      containers:
      - name: node-exporter
        image: quay.io/prometheus/node-exporter:v1.6.1
        args:
        - "--path.rootfs=/host"
        resources:
          requests:
            memory: 64Mi
            cpu: 50m
          limits:
            memory: 128Mi
            cpu: 100m
        volumeMounts:
        - name: root
          mountPath: /host
          readOnly: true
      volumes:
      - name: root
        hostPath:
          path: /
---
apiVersion: v1
kind: Service
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app: node-exporter
spec:
  clusterIP: None
  ports:
  - name: metrics
    port: 9100
    targetPort: 9100
  selector:
    app: node-exporter
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  endpoints:
  - port: metrics
    interval: 15s
EOF

        # 6. Kube-State-Metrics (Required for Dashboard 15760 & others)
        echo "Step 5/5: Installing Kube-State-Metrics (Cluster Object Metrics)..."
        cat <<EOF | kubectl apply -n monitoring -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kube-state-metrics
  namespace: monitoring
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-state-metrics
rules:
- apiGroups: [""]
  resources: ["configmaps", "secrets", "nodes", "pods", "services", "resourcequotas", "replicationcontrollers", "limitranges", "persistentvolumeclaims", "persistentvolumes", "namespaces", "endpoints"]
  verbs: ["list", "watch"]
- apiGroups: ["apps"]
  resources: ["statefulsets", "daemonsets", "deployments", "replicasets"]
  verbs: ["list", "watch"]
- apiGroups: ["batch"]
  resources: ["cronjobs", "jobs"]
  verbs: ["list", "watch"]
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["list", "watch"]
- apiGroups: ["authentication.k8s.io"]
  resources: ["tokenreviews"]
  verbs: ["create"]
- apiGroups: ["authorization.k8s.io"]
  resources: ["subjectaccessreviews"]
  verbs: ["create"]
- apiGroups: ["policy"]
  resources: ["poddisruptionbudgets"]
  verbs: ["list", "watch"]
- apiGroups: ["certificates.k8s.io"]
  resources: ["certificatesigningrequests"]
  verbs: ["list", "watch"]
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses", "volumeattachments"]
  verbs: ["list", "watch"]
- apiGroups: ["admissionregistration.k8s.io"]
  resources: ["mutatingwebhookconfigurations", "validatingwebhookconfigurations"]
  verbs: ["list", "watch"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies", "ingresses"]
  verbs: ["list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-state-metrics
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kube-state-metrics
subjects:
- kind: ServiceAccount
  name: kube-state-metrics
  namespace: monitoring
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    app.kubernetes.io/name: kube-state-metrics
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  template:
    metadata:
      labels:
        app.kubernetes.io/name: kube-state-metrics
    spec:
      serviceAccountName: kube-state-metrics
      containers:
      - name: kube-state-metrics
        image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.9.2
        ports:
        - containerPort: 8080
          name: http-metrics
        - containerPort: 8081
          name: telemetry
        resources:
          requests:
            memory: 128Mi
            cpu: 100m
          limits:
            memory: 256Mi
            cpu: 200m
---
apiVersion: v1
kind: Service
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    app.kubernetes.io/name: kube-state-metrics
spec:
  ports:
  - name: http-metrics
    port: 8080
    targetPort: http-metrics
  - name: telemetry
    port: 8081
    targetPort: telemetry
  selector:
    app.kubernetes.io/name: kube-state-metrics
---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: kube-state-metrics
  namespace: monitoring
  labels:
    app.kubernetes.io/name: kube-state-metrics
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: kube-state-metrics
  endpoints:
  - port: http-metrics
    interval: 15s
EOF

        echo "✓ Monitoring stack installed successfully"
        echo ""
        echo "Access URLs:"
        echo "   - Prometheus: http://<node-ip>:30090"
        echo "   - Grafana:    http://<node-ip>:30000 (User: admin / Pass: admin)"
        echo ""
        echo "Verify installation:"
        echo "   kubectl get pods -n monitoring"
        echo "   kubectl get servicemonitors -n monitoring"
        ;;
        
    dashboard)
        echo "Installing Kubernetes Dashboard..."
        kubectl apply -f https://raw.githubusercontent.com/kubernetes/dashboard/v2.7.0/aio/deploy/recommended.yaml
        
        # Create admin user with view-only access (more secure)
        cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: dashboard-viewer
  namespace: kubernetes-dashboard
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: dashboard-viewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
- kind: ServiceAccount
  name: dashboard-viewer
  namespace: kubernetes-dashboard
---
# Optional: Create admin user (WARNING: Full cluster access)
apiVersion: v1
kind: ServiceAccount
metadata:
  name: dashboard-admin
  namespace: kubernetes-dashboard
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: dashboard-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- kind: ServiceAccount
  name: dashboard-admin
  namespace: kubernetes-dashboard
EOF
        
        echo "✓ Kubernetes Dashboard installed"
        echo ""
        echo "To access the dashboard:"
        echo "1. Run: kubectl proxy"
        echo "2. Visit: http://localhost:8001/api/v1/namespaces/kubernetes-dashboard/services/https:kubernetes-dashboard:/proxy/"
        echo ""
        echo "Get tokens:"
        echo "   Viewer (read-only): kubectl -n kubernetes-dashboard create token dashboard-viewer"
        echo "   Admin (full access): kubectl -n kubernetes-dashboard create token dashboard-admin"
        echo ""
        echo "⚠️  WARNING: dashboard-admin has full cluster access. Use dashboard-viewer for normal operations."
        ;;
        
    *)
        echo "Error: Unknown add-on: $ADDON"
        echo "Available add-ons: ingress, monitoring, dashboard"
        echo ""
        echo "Note: 'logging' add-on has been removed. Use a dedicated logging solution like:"
        echo "  - Loki Stack: https://grafana.com/docs/loki/latest/installation/"
        echo "  - EFK Stack: https://www.elastic.co/elastic-stack/"
        exit 1
        ;;
esac

echo "========================================="
echo "Add-on installation complete!"
echo "========================================="
