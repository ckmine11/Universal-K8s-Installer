#!/bin/bash
# KubeEZ — uninstall an add-on cleanly (run on the primary control-plane).
#
# Usage: addon-uninstall.sh <addon> [kubeconfig] [namespace]
#   addon: ingress | monitoring | dashboard | cert-manager | longhorn | argocd | seaweedfs | velero | explorer |
#          metrics-server | metallb | loki | sealed-secrets | kyverno | nfs-provisioner | snapshot-controller |
#          elasticsearch | fluentd | fluent-bit | harbor | flux | jenkins | vault | gatekeeper | falco | trivy-operator
#   (any other add-on: pass its namespace as the 3rd argument → generic removal)
#
# Removes exactly what the KubeEZ installer created: the namespace AND the
# cluster-wide pieces (CRDs, ClusterRoles, webhooks, StorageClass) — a
# leftover admission webhook would otherwise block API calls later.
# Failures end with:  KUBEEZ_FAIL|CODE|reason|fix   (shown on the failure screen)
# Idempotent: uninstalling something that is not installed succeeds.

set -o pipefail
ADDON="${1:-}"
export KUBECONFIG="${2:-/etc/kubernetes/admin.conf}"
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/snap/bin

log()  { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "KUBEEZ_FAIL|$1|$(printf '%s' "$2" | tr '|\n' '/ ')|$(printf '%s' "$3" | tr '|\n' '/ ')"; exit 1; }
progress() { echo "KUBEEZ_PROGRESS|$1|$2"; }
del() { kubectl delete --ignore-not-found --wait=false "$@" 2>&1 | grep -v '^$' | sed 's/^/  /' || true; }

kubectl get --raw=/readyz >/dev/null 2>&1 \
    || fail API_SERVER_DOWN "The Kubernetes API server is not answering, so nothing was removed." \
            "Check the control plane ('kubectl get nodes' on the master), then try again."

# Delete a namespace and wait. If it hangs in Terminating (a custom resource
# whose controller is already gone keeps a finalizer), clear the finalizers.
delete_ns() {
    local ns="$1" i
    kubectl get ns "$ns" >/dev/null 2>&1 || { log "Namespace $ns already gone"; return 0; }
    log "Deleting namespace $ns..."
    kubectl delete ns "$ns" --wait=false >/dev/null 2>&1
    for i in $(seq 1 36); do                       # up to 3 min
        kubectl get ns "$ns" >/dev/null 2>&1 || { log "✓ Namespace $ns deleted"; return 0; }
        [ $((i % 6)) -eq 0 ] && log "…still deleting $ns ($((i * 5))s)"
        sleep 5
    done
    log "Namespace $ns is stuck — clearing finalizers of leftover resources..."
    local kinds r
    kinds=$(kubectl api-resources --namespaced=true --verbs=list -o name 2>/dev/null | grep -v '^events')
    for k in $kinds; do
        for r in $(kubectl -n "$ns" get "$k" -o name 2>/dev/null); do
            kubectl -n "$ns" patch "$r" --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 && log "  cleared $r"
        done
    done
    for i in $(seq 1 24); do
        kubectl get ns "$ns" >/dev/null 2>&1 || { log "✓ Namespace $ns deleted"; return 0; }
        sleep 5
    done
    fail NAMESPACE_STUCK "Namespace $ns is still terminating after 5 minutes." \
         "Run 'kubectl get ns $ns -o yaml' and 'kubectl api-resources --verbs=list --namespaced -o name | xargs -n1 kubectl get -n $ns --ignore-not-found' on the master to see what is left, then try again."
}

# Helm add-ons: uninstall every release in the namespace first — Helm removes
# the cluster-wide pieces it created (RBAC, webhooks, API registrations)
helm_remove() {
    local ns="$1" rel
    command -v helm >/dev/null 2>&1 || return 0
    for rel in $(helm -n "$ns" list -aq 2>/dev/null); do
        log "Removing Helm release $rel..."
        helm -n "$ns" uninstall "$rel" --wait --timeout 5m 2>&1 | tail -2 | sed 's/^/  /' || true
    done
}

echo "========================================="
echo "Uninstalling add-on: $ADDON"
echo "========================================="
progress 10 "Removing ${ADDON}"

case "$ADDON" in
ingress)
    helm_remove ingress-nginx
    del validatingwebhookconfiguration ingress-nginx-admission
    progress 30 "Removing the controller"
    delete_ns ingress-nginx
    del clusterrole ingress-nginx ingress-nginx-admission
    del clusterrolebinding ingress-nginx ingress-nginx-admission
    del ingressclass nginx
    ;;

monitoring)
    helm_remove monitoring
    del validatingwebhookconfiguration,mutatingwebhookconfiguration kubeez-admission
    del -n monitoring secret grafana-admin
    # Custom resources first, while the operator is still running to finalize them
    del -n monitoring prometheus.monitoring.coreos.com --all
    del -n monitoring servicemonitor.monitoring.coreos.com --all
    progress 30 "Removing Prometheus, Grafana and exporters"
    delete_ns monitoring
    del clusterrole prometheus prometheus-operator kube-state-metrics
    del clusterrolebinding prometheus prometheus-operator kube-state-metrics
    progress 80 "Removing monitoring CRDs"
    for crd in $(kubectl get crd -o name 2>/dev/null | grep 'monitoring.coreos.com'); do del "$crd"; done
    ;;

dashboard)
    helm_remove kubernetes-dashboard
    delete_ns kubernetes-dashboard
    del clusterrole kubernetes-dashboard
    del clusterrolebinding kubernetes-dashboard dashboard-admin dashboard-viewer
    ;;

cert-manager)
    helm_remove cert-manager
    # Webhooks first — a dangling cert-manager webhook makes the API reject
    # unrelated requests once the webhook pod is gone.
    del validatingwebhookconfiguration cert-manager-webhook
    del mutatingwebhookconfiguration cert-manager-webhook
    del clusterissuer.cert-manager.io selfsigned-issuer
    progress 30 "Removing cert-manager"
    delete_ns cert-manager
    del -n kube-system role,rolebinding -l app.kubernetes.io/instance=cert-manager
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=cert-manager
    progress 80 "Removing cert-manager CRDs (and every Certificate/Issuer)"
    del crd -l app.kubernetes.io/instance=cert-manager
    ;;

argocd)
    helm_remove argocd
    # Applications carry a finalizer that needs the (soon gone) controller
    for r in $(kubectl get applications.argoproj.io,applicationsets.argoproj.io,appprojects.argoproj.io -A -o jsonpath='{range .items[*]}{.kind}/{.metadata.name} -n {.metadata.namespace}{"\n"}{end}' 2>/dev/null | tr ' ' '#'); do
        kubectl patch $(echo "$r" | tr '#' ' ') --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
    done
    progress 30 "Removing ArgoCD"
    delete_ns argocd
    del clusterrole,clusterrolebinding -l app.kubernetes.io/part-of=argocd
    progress 80 "Removing ArgoCD CRDs"
    del crd -l app.kubernetes.io/part-of=argocd
    ;;

longhorn)
    # Never pull storage out from under running workloads.
    INUSE=$(kubectl get pv -o jsonpath='{range .items[*]}{.spec.csi.driver}{" "}{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}{end}' 2>/dev/null \
        | awk '$1=="driver.longhorn.io"{print $2}' | tr '\n' ' ')
    if [ -n "$INUSE" ]; then
        fail LONGHORN_IN_USE "Longhorn still holds volumes: ${INUSE}— removing it would destroy that data." \
             "Back up and delete those PVCs (and the apps using them) first, then uninstall Longhorn again."
    fi
    if kubectl get ns longhorn-system >/dev/null 2>&1; then
        LH_IMG=$(kubectl -n longhorn-system get ds longhorn-manager -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)
        LH_VERSION=$(printf '%s' "$LH_IMG" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        if [ -n "$LH_VERSION" ]; then
            BASE="https://raw.githubusercontent.com/longhorn/longhorn/${LH_VERSION}"
            log "Longhorn ${LH_VERSION} — running its official uninstaller..."
            kubectl -n longhorn-system patch settings.longhorn.io deleting-confirmation-flag --type=merge -p '{"value":"true"}' >/dev/null 2>&1 || true
            curl -fsSL --retry 3 -m 60 "${BASE}/uninstall/uninstall.yaml" -o /tmp/lh-uninstall.yaml \
                || fail NO_INTERNET "Could not download Longhorn's uninstaller (${BASE}/uninstall/uninstall.yaml)." \
                        "Allow the master to reach raw.githubusercontent.com, then try again."
            kubectl create -f /tmp/lh-uninstall.yaml 2>&1 | sed 's/^/  /' || true
            progress 30 "Longhorn uninstaller running"
            if ! kubectl -n longhorn-system wait --for=condition=complete job/longhorn-uninstall --timeout=600s; then
                kubectl -n longhorn-system logs job/longhorn-uninstall --tail=20 2>/dev/null | sed 's/^/  /'
                fail LONGHORN_UNINSTALL_FAILED "Longhorn's uninstaller did not finish within 10 minutes (log above)." \
                     "Check 'kubectl -n longhorn-system logs job/longhorn-uninstall', fix the reported problem, then try again."
            fi
            log "✓ Longhorn uninstaller finished"
            progress 60 "Removing Longhorn components"
            curl -fsSL --retry 3 -m 60 "${BASE}/deploy/longhorn.yaml" -o /tmp/lh.yaml && kubectl delete --ignore-not-found -f /tmp/lh.yaml 2>&1 | tail -3 | sed 's/^/  /'
            kubectl delete --ignore-not-found -f /tmp/lh-uninstall.yaml >/dev/null 2>&1 || true
        fi
        for ns in default longhorn-system; do del -n $ns ds longhorn-iscsi-installation longhorn-nfs-installation; done
        delete_ns longhorn-system
    fi
    del storageclass longhorn longhorn-static
    del crd -l app.kubernetes.io/name=longhorn
    ;;

seaweedfs)
    helm_remove seaweedfs
    if kubectl -n seaweedfs get pvc seaweedfs-data >/dev/null 2>&1; then
        log "⚠ The SeaweedFS volume (PVC seaweedfs-data) and all stored objects are deleted."
    else
        log "Note: objects stored on the node itself (/var/lib/kubeez-seaweedfs) are kept — delete that folder by hand if you no longer need it."
    fi
    delete_ns seaweedfs
    ;;

explorer)
    for rel in kubeez-explorer radar; do   # "radar": installs from before the rename
        if command -v helm >/dev/null 2>&1 && helm -n kubeez-explorer status "$rel" >/dev/null 2>&1; then
            log "Removing the Explorer (helm uninstall $rel)..."
            helm -n kubeez-explorer uninstall "$rel" --wait --timeout 3m 2>&1 | tail -2 | sed 's/^/  /' || true
        fi
    done
    delete_ns kubeez-explorer
    del clusterrolebinding kubeez-explorer-admins kubeez-explorer-operators kubeez-explorer-viewers kubeez-explorer-cluster-read kubeez-explorer-helm-gate
    del clusterrole kubeez-explorer-cluster-read kubeez-explorer-helm-gate
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=radar
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=kubeez-explorer
    ;;

velero)
    helm_remove velero
    # Backups already in the bucket are NOT deleted — reinstalling with the
    # same settings lists them again.
    if command -v velero >/dev/null 2>&1 && kubectl get ns velero >/dev/null 2>&1; then
        log "Running 'velero uninstall'..."
        timeout 300 velero uninstall --force 2>&1 | tail -3 | sed 's/^/  /' || true
    fi
    delete_ns velero
    del clusterrolebinding velero
    del crd -l component=velero
    log "Backups already in the storage bucket are kept."
    ;;

metrics-server)
    helm_remove metrics-server
    # A leftover metrics API pointing at a deleted Service breaks API discovery
    # (namespace deletion, kubectl api-resources) — remove it if it is ours
    if [ "$(kubectl get apiservice v1beta1.metrics.k8s.io -o jsonpath='{.spec.service.namespace}' 2>/dev/null)" = "metrics-server" ]; then
        del apiservice v1beta1.metrics.k8s.io
    fi
    delete_ns metrics-server
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=metrics-server
    ;;

metallb)
    helm_remove metallb-system
    delete_ns metallb-system
    del validatingwebhookconfiguration metallb-webhook-configuration
    del crd bfdprofiles.metallb.io bgpadvertisements.metallb.io bgppeers.metallb.io communities.metallb.io configurationstates.metallb.io ipaddresspools.metallb.io l2advertisements.metallb.io servicebgpstatuses.metallb.io servicel2statuses.metallb.io
    log "LoadBalancer Services go back to <pending>; Nginx Ingress keeps its node ports."
    ;;

loki)
    helm_remove logging
    del -n monitoring configmap kubeez-loki-datasource
    delete_ns logging
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=loki
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=fluent-bit
    rm -f /var/log/kubeez-fluent-bit.db* 2>/dev/null || true
    ;;

sealed-secrets)
    helm_remove sealed-secrets
    delete_ns sealed-secrets
    del crd sealedsecrets.bitnami.com
    ;;

kyverno)
    # Policies first, then Kyverno; its webhooks must never outlive it
    del validatingpolicies.policies.kyverno.io -l app.kubernetes.io/managed-by=kubeez
    helm_remove kyverno
    # Kyverno pods still shutting down re-create their webhooks — remove them
    # once the namespace (and every Kyverno pod) is gone, and check they stay gone
    delete_ns kyverno
    for _ in 1 2 3; do
        del validatingwebhookconfiguration,mutatingwebhookconfiguration -l webhook.kyverno.io/managed-by=kyverno
        for w in $(kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name 2>/dev/null | grep '/kyverno-'); do del "$w"; done
        sleep 3
        kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name 2>/dev/null | grep -q kyverno || break
    done
    kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name 2>/dev/null | grep -q kyverno         && fail WEBHOOK_LEFT "A Kyverno admission webhook is still registered." "Delete it: kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep kyverno"
    ;;

nfs-provisioner)
    # Never pull storage out from under running workloads.
    INUSE=$(kubectl get pv -o jsonpath='{range .items[*]}{.spec.storageClassName}{" "}{.spec.claimRef.namespace}/{.spec.claimRef.name}{"\n"}{end}' 2>/dev/null \
        | awk '$1=="nfs-client"{print $2}' | grep -v '^nfs-provisioner/' | tr '\n' ' ')
    if [ -n "$INUSE" ]; then
        fail NFS_IN_USE "Volumes on NFS are still in use: ${INUSE}— without the provisioner they could not be deleted cleanly." \
             "Delete those PVCs (and the apps using them) first, then uninstall again. The data on the NFS server is never deleted."
    fi
    helm_remove nfs-provisioner
    delete_ns nfs-provisioner
    del storageclass nfs-client
    del clusterrole,clusterrolebinding -l app=nfs-subdir-external-provisioner
    log "The data on the NFS server is kept."
    ;;

snapshot-controller)
    del volumesnapshotclass longhorn-snapshot
    helm_remove snapshot-controller
    delete_ns snapshot-controller
    # the snapshot types stay while snapshots exist (they belong to the user)
    if [ -z "$(kubectl get volumesnapshots.snapshot.storage.k8s.io -A -o name 2>/dev/null)" ] && [ -z "$(kubectl get volumesnapshotcontents.snapshot.storage.k8s.io -o name 2>/dev/null)" ]; then
        for crd in volumesnapshotclasses.snapshot.storage.k8s.io volumesnapshotcontents.snapshot.storage.k8s.io volumesnapshots.snapshot.storage.k8s.io \
                   volumegroupsnapshotclasses.groupsnapshot.storage.k8s.io volumegroupsnapshotcontents.groupsnapshot.storage.k8s.io volumegroupsnapshots.groupsnapshot.storage.k8s.io; do
            del crd "$crd"
        done
    else
        log "Snapshots exist — the snapshot CRDs (and your snapshots) are kept."
    fi
    ;;

elasticsearch)
    # Elasticsearch / Kibana first, while the operator still runs to clean them up
    del -n elastic-system kibana.kibana.k8s.elastic.co --all
    del -n elastic-system elasticsearch.elasticsearch.k8s.elastic.co --all
    for _ in $(seq 1 24); do
        kubectl -n elastic-system get pods -l common.k8s.elastic.co/type -o name 2>/dev/null | grep -q . || break
        sleep 5
    done
    helm_remove elastic-system
    delete_ns elastic-system
    del validatingwebhookconfiguration elastic-operator.elastic-system.k8s.elastic.co
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=elastic-operator
    for crd in $(kubectl get crd -o name 2>/dev/null | grep '\.k8s\.elastic\.co$'); do del "$crd"; done
    ;;

fluentd)
    helm_remove fluentd
    delete_ns fluentd
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=fluentd
    ;;

fluent-bit)
    helm_remove fluent-bit
    delete_ns fluent-bit
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=kubeez-fluent-bit
    ;;

harbor)
    helm_remove harbor
    delete_ns harbor
    log "Nodes keep Harbor's certificate in /etc/containerd/certs.d (harmless; delete the folder by hand if you like)."
    ;;

flux)
    # never delete what Flux deployed: no pruning, then let the objects go without their finalizers
    for k in kustomizations.kustomize.toolkit.fluxcd.io helmreleases.helm.toolkit.fluxcd.io; do
        for r in $(kubectl get "$k" -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
            kubectl -n "${r%%/*}" patch "$k" "${r#*/}" --type merge -p '{"spec":{"suspend":true,"prune":false}}' >/dev/null 2>&1 || true
        done
    done
    for k in $(kubectl get crd -o name 2>/dev/null | grep 'toolkit\.fluxcd\.io$' | sed 's#.*/##'); do
        for r in $(kubectl get "$k" -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
            kubectl -n "${r%%/*}" patch "$k" "${r#*/}" --type merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
        done
    done
    helm_remove flux-system
    delete_ns flux-system
    del clusterrole,clusterrolebinding -l app.kubernetes.io/part-of=flux
    for crd in $(kubectl get crd -o name 2>/dev/null | grep 'toolkit\.fluxcd\.io$'); do del "$crd"; done
    log "What Flux deployed from Git stays in the cluster."
    ;;

jenkins)
    helm_remove jenkins
    delete_ns jenkins
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=jenkins
    ;;

vault)
    helm_remove vault
    del mutatingwebhookconfiguration vault-agent-injector-cfg
    delete_ns vault
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=vault
    ;;

gatekeeper)
    # Policies first, then Gatekeeper; its webhooks must never outlive it
    del constrainttemplates.templates.gatekeeper.sh -l app.kubernetes.io/managed-by=kubeez
    helm_remove gatekeeper-system
    del validatingwebhookconfiguration gatekeeper-validating-webhook-configuration
    del mutatingwebhookconfiguration gatekeeper-mutating-webhook-configuration
    delete_ns gatekeeper-system
    for crd in $(kubectl get crd -o name 2>/dev/null | grep 'gatekeeper\.sh$'); do del "$crd"; done
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=gatekeeper
    kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name 2>/dev/null | grep -q gatekeeper \
        && fail WEBHOOK_LEFT "A Gatekeeper admission webhook is still registered." "Delete it: kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep gatekeeper"
    ;;

falco)
    helm_remove falco
    delete_ns falco
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=falco
    ;;

trivy-operator)
    helm_remove trivy-system
    delete_ns trivy-system
    del clusterrole,clusterrolebinding -l app.kubernetes.io/instance=trivy-operator
    for crd in $(kubectl get crd -o name 2>/dev/null | grep 'aquasecurity\.github\.io$'); do del "$crd"; done
    ;;

*)
    # Any other registered add-on: its namespace is passed in (generic removal),
    # so a new add-on is manageable from the UI without a script change.
    GENERIC_NS="${3:-}"
    [ -n "$GENERIC_NS" ] || fail UNKNOWN_ADDON "Unknown add-on '$ADDON'." "Choose one of: ingress, monitoring, dashboard, cert-manager, longhorn, argocd, seaweedfs, velero, explorer."
    case "$GENERIC_NS" in kube-system|kube-public|kube-node-lease|default) fail UNSAFE_NAMESPACE "Refusing to delete the system namespace '$GENERIC_NS'." "Add a dedicated uninstall step for '$ADDON' to addon-uninstall.sh." ;; esac
    delete_ns "$GENERIC_NS"
    ;;
esac

progress 100 "${ADDON} removed"
echo "✓ Add-on '$ADDON' uninstalled"
echo "========================================="
