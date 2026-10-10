# Third-party software

KubeEZ installs and drives these open-source projects in your clusters. They are
not modified or bundled into KubeEZ; KubeEZ deploys their official published
releases (container images / Helm charts) and talks to them over their APIs.

| Component | Used for | License | Source |
|---|---|---|---|
| **Radar** by Skyhook | Engine of the KubeEZ Explorer add-on: Kubernetes UI, best-practice audit, upgrade impact analysis (used unmodified; KubeEZ branding is applied when pages are served) | Apache-2.0 | https://github.com/skyhook-io/radar |
| **Velero** | Volume Backups add-on | Apache-2.0 | https://github.com/velero-io/velero |
| **SeaweedFS** | S3 Object Storage add-on | Apache-2.0 | https://github.com/seaweedfs/seaweedfs |
| **Longhorn** | Longhorn Storage add-on | Apache-2.0 | https://github.com/longhorn/longhorn |
| **Argo CD** | ArgoCD add-on | Apache-2.0 | https://github.com/argoproj/argo-cd |
| **cert-manager** | cert-manager add-on | Apache-2.0 | https://github.com/cert-manager/cert-manager |
| **ingress-nginx** | Nginx Ingress add-on | Apache-2.0 | https://github.com/kubernetes/ingress-nginx |
| **Prometheus**, **Grafana** | Monitoring add-on | Apache-2.0 / AGPL-3.0 | https://github.com/prometheus/prometheus · https://github.com/grafana/grafana |
| **Kubernetes Dashboard** | Dashboard add-on | Apache-2.0 | https://github.com/kubernetes/dashboard |
| **Metrics Server** | Metrics Server add-on | Apache-2.0 | https://github.com/kubernetes-sigs/metrics-server |
| **MetalLB** | MetalLB add-on | Apache-2.0 | https://github.com/metallb/metallb |
| **Loki**, **Fluent Bit** | Loki logs add-on | AGPL-3.0 / Apache-2.0 | https://github.com/grafana/loki · https://github.com/fluent/fluent-bit |
| **Sealed Secrets** (controller, kubeseal) | Sealed Secrets add-on | Apache-2.0 | https://github.com/bitnami/sealed-secrets |
| **Kyverno** | Kyverno policies add-on | Apache-2.0 | https://github.com/kyverno/kyverno |
| **Helm** | Installs the add-ons above on the control-plane | Apache-2.0 | https://github.com/helm/helm |
| **etcd** (etcdctl / etcdutl) | etcd snapshots, restore, recovery | Apache-2.0 | https://github.com/etcd-io/etcd |

"Radar" and "Skyhook" are names of their respective owners; KubeEZ calls the
feature "KubeEZ Explorer"; this file is where the engine is credited.
