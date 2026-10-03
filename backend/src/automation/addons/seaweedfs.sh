#!/bin/bash
# KubeEZ - Install S3 Object Storage (SeaweedFS)
# Actively maintained, S3-compatible object storage for apps in the cluster —
# and a target for OTHER clusters' offsite etcd backups.
# (MinIO's open-source images are no longer published, so KubeEZ ships SeaweedFS.)
#
# - Single-pod "weed server" (master + volume + filer + S3 gateway)
# - S3 API with access/secret key auth on NodePort 30833
# - Web admin UI ("weed admin": file browser, buckets, volumes) with a
#   username/password login on NodePort 30834 — never exposed without a password
# - Data on the default StorageClass (e.g. Longhorn) if there is one,
#   otherwise a hostPath on one pinned node
# - Creates a "backups" bucket; credentials live in Secret seaweedfs/seaweedfs-s3
# - Idempotent: re-running keeps the existing credentials and data

set -eo pipefail

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/snap/bin

NS=seaweedfs
IMAGE=${SEAWEEDFS_IMAGE:-chrislusf/seaweedfs:4.48}
NODE_PORT=30833
ADMIN_NODE_PORT=30834
SIZE=${SEAWEEDFS_SIZE:-20Gi}

log() { echo "[$(date +%H:%M:%S)] $*"; }
retry() { local m=$1; shift; local n=1; until "$@"; do [ $n -ge $m ] && { log "FAILED after $m attempts: $*"; return 1; }; log "attempt $n/$m failed, retrying in $((n*5))s..."; sleep $((n*5)); n=$((n+1)); done; }
kapply() { retry 5 kubectl apply "$@"; }

echo "========================================="
echo "Installing S3 Object Storage (SeaweedFS)"
echo "========================================="

log "Step 1/5: Namespace + credentials..."
kubectl create namespace $NS --dry-run=client -o yaml | kapply -f -
if kubectl -n $NS get secret seaweedfs-s3 >/dev/null 2>&1; then
    log "Reusing existing S3 credentials"
else
    ACCESS="KZ$(openssl rand -hex 9 | tr 'a-f' 'A-F')"
    SECRET="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40)"
    S3JSON=$(printf '{"identities":[{"name":"kubeez","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' "$ACCESS" "$SECRET")
    kubectl -n $NS create secret generic seaweedfs-s3 \
        --from-literal=accessKey="$ACCESS" --from-literal=secretKey="$SECRET" --from-literal=s3.json="$S3JSON" >/dev/null
    log "Generated new S3 credentials (Secret $NS/seaweedfs-s3)"
fi
# Web UI password — also added to installs that predate the web UI
if [ -z "$(kubectl -n $NS get secret seaweedfs-s3 -o jsonpath='{.data.adminPassword}' 2>/dev/null)" ]; then
    ADMIN_PW="$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)"
    kubectl -n $NS patch secret seaweedfs-s3 --type=merge \
        -p "{\"stringData\":{\"adminUser\":\"admin\",\"adminPassword\":\"$ADMIN_PW\"}}" >/dev/null
    log "Generated the web UI login (user 'admin')"
fi

log "Step 2/5: Storage..."
DEFAULT_SC=$(kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' 2>/dev/null | head -1 || true)
if [ -n "$DEFAULT_SC" ]; then
    log "Using default StorageClass '$DEFAULT_SC' ($SIZE)"
    cat <<EOF | kapply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: seaweedfs-data
  namespace: $NS
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: $SIZE
EOF
    VOLUME='persistentVolumeClaim:
          claimName: seaweedfs-data'
    PLACEMENT=''
else
    # No StorageClass: keep data on ONE node so it survives pod restarts.
    # Prefer a worker; fall back to the control-plane on single-node clusters.
    PIN=$(kubectl get pods -n $NS -l app=seaweedfs -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
    [ -z "$PIN" ] && PIN=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    [ -z "$PIN" ] && PIN=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')
    log "No default StorageClass — storing data in /var/lib/kubeez-seaweedfs on node '$PIN'"
    log "(install Longhorn for replicated storage)"
    VOLUME='hostPath:
          path: /var/lib/kubeez-seaweedfs
          type: DirectoryOrCreate'
    PLACEMENT="nodeSelector:
        kubernetes.io/hostname: $PIN
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule"
fi

log "Step 3/5: Deploying SeaweedFS ($IMAGE)..."
cat <<EOF | kapply -f -
apiVersion: apps/v1
kind: Deployment
metadata:
  name: seaweedfs
  namespace: $NS
  labels: { app: seaweedfs }
spec:
  replicas: 1
  strategy: { type: Recreate }
  selector:
    matchLabels: { app: seaweedfs }
  template:
    metadata:
      labels: { app: seaweedfs }
    spec:
      $PLACEMENT
      containers:
      - name: seaweedfs
        image: $IMAGE
        command: ["weed"]
        args:
        - server
        - -dir=/data
        - -ip=\$(POD_IP)
        - -ip.bind=0.0.0.0
        - -master.volumeSizeLimitMB=1024
        - -volume.max=0
        - -filer
        - -s3
        - -s3.port=8333
        - -s3.config=/etc/seaweedfs/s3.json
        # A typo in a bucket name must fail, not silently create a new bucket
        - -s3.autoCreateBucket=false
        env:
        - name: POD_IP
          valueFrom: { fieldRef: { fieldPath: status.podIP } }
        ports:
        - { name: s3, containerPort: 8333 }
        readinessProbe:
          tcpSocket: { port: 8333 }
          initialDelaySeconds: 10
          periodSeconds: 10
        livenessProbe:
          tcpSocket: { port: 9333 }
          initialDelaySeconds: 30
          periodSeconds: 20
        resources:
          requests: { cpu: 100m, memory: 256Mi }
          limits: { memory: 1Gi }
        volumeMounts:
        - { name: data, mountPath: /data }
        - { name: s3config, mountPath: /etc/seaweedfs, readOnly: true }
      # Web admin UI — talks to the master in this pod; login required
      - name: admin
        image: $IMAGE
        command: ["weed"]
        args:
        - admin
        - -port=23646
        # Listen on the pod IP (it otherwise picks loopback in some setups); safe
        # because a password is always set (generated above)
        - -ip=0.0.0.0
        - -master=localhost:9333
        # \$(VAR) = Kubernetes env expansion (escaped so the shell heredoc keeps it)
        - -adminUser=\$(ADMIN_USER)
        - -adminPassword=\$(ADMIN_PASSWORD)
        - -dataDir=/data/.admin
        env:
        - name: ADMIN_USER
          valueFrom: { secretKeyRef: { name: seaweedfs-s3, key: adminUser } }
        - name: ADMIN_PASSWORD
          valueFrom: { secretKeyRef: { name: seaweedfs-s3, key: adminPassword } }
        ports:
        - { name: admin, containerPort: 23646 }
        readinessProbe:
          tcpSocket: { port: 23646 }
          initialDelaySeconds: 15
          periodSeconds: 10
        resources:
          requests: { cpu: 20m, memory: 64Mi }
          limits: { memory: 256Mi }
        volumeMounts:
        - { name: data, mountPath: /data }
      volumes:
      - name: data
        $VOLUME
      - name: s3config
        secret:
          secretName: seaweedfs-s3
          items: [{ key: s3.json, path: s3.json }]
---
apiVersion: v1
kind: Service
metadata:
  name: seaweedfs-s3
  namespace: $NS
spec:
  type: NodePort
  selector: { app: seaweedfs }
  ports:
  - { name: s3, port: 8333, targetPort: 8333, nodePort: $NODE_PORT }
---
apiVersion: v1
kind: Service
metadata:
  name: seaweedfs-admin
  namespace: $NS
spec:
  type: NodePort
  selector: { app: seaweedfs }
  ports:
  - { name: admin, port: 23646, targetPort: 23646, nodePort: $ADMIN_NODE_PORT }
EOF

# Safety: the web UI must take its password from the Secret — never run it
# without one (an empty value would mean a login-free admin UI).
ADMIN_ARGS=$(kubectl -n $NS get deploy seaweedfs -o jsonpath='{.spec.template.spec.containers[?(@.name=="admin")].args}' 2>/dev/null || true)
case "$ADMIN_ARGS" in
    *'-adminPassword=$(ADMIN_PASSWORD)'*) ;;
    *) echo "KUBEEZ_FAIL|ADMIN_UI_NO_PASSWORD|The SeaweedFS web UI was not configured with its password, so it was not started.|Report this to KubeEZ support; S3 itself is unaffected."; exit 1 ;;
esac

log "Step 4/5: Waiting for SeaweedFS to be ready (up to 8 min)..."
# Watch the pod and stop EARLY with the real reason instead of waiting blindly
# (KUBEEZ_FAIL lines are shown on the KubeEZ failure screen).
fail() {
    echo "--- pod status ---"; kubectl -n $NS get pods,pvc -o wide 2>/dev/null
    echo "--- recent events ---"; kubectl -n $NS get events --sort-by=.lastTimestamp 2>/dev/null | tail -8
    echo "KUBEEZ_FAIL|$1|$(printf '%s' "$2" | tr '|\n' '/ ')|$(printf '%s' "$3" | tr '|\n' '/ ')"
    exit 1
}
START=$(date +%s)
while true; do
    ELAPSED=$(( $(date +%s) - START ))
    READY=$(kubectl -n $NS get deploy seaweedfs -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)
    [ "${READY:-0}" -ge 1 ] && { log "✓ SeaweedFS is ready (${ELAPSED}s)"; break; }

    POD=$(kubectl -n $NS get pods -l app=seaweedfs -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    # Two containers (seaweedfs + admin): report whichever one is stuck
    WAITING=$(kubectl -n $NS get pod "$POD" -o jsonpath='{range .status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}' 2>/dev/null | grep -m1 . || true)
    WAITMSG=$(kubectl -n $NS get pod "$POD" -o jsonpath='{range .status.containerStatuses[*]}{.state.waiting.message}{"\n"}{end}' 2>/dev/null | grep -m1 . | cut -c1-200 || true)
    SCHED=$(kubectl -n $NS get pod "$POD" -o jsonpath='{.status.conditions[?(@.type=="PodScheduled")].message}' 2>/dev/null | cut -c1-200 || true)
    PVC=$(kubectl -n $NS get pvc seaweedfs-data -o jsonpath='{.status.phase}' 2>/dev/null || true)

    case "$WAITING" in
        ErrImagePull|ImagePullBackOff|InvalidImageName)
            fail IMAGE_PULL_FAILED "The nodes cannot download the SeaweedFS image ($IMAGE): $WAITMSG" \
                 "Allow the nodes to reach Docker Hub (registry-1.docker.io), then install the add-on again." ;;
        CrashLoopBackOff)
            echo "--- SeaweedFS log ---"; kubectl -n $NS logs "$POD" --all-containers --prefix --tail=20 2>/dev/null
            fail ADDON_CRASHING "SeaweedFS keeps crashing (see its log above)." "Check free disk space on the node and the log above, then install the add-on again." ;;
    esac
    # A volume that never binds also shows up as an "unschedulable" pod — report
    # it as the storage problem it is (checked before the scheduling message).
    if [ "$PVC" = "Pending" ] && [ $ELAPSED -ge 90 ]; then
        fail STORAGE_PENDING "The storage volume for SeaweedFS is still Pending: the default StorageClass '$DEFAULT_SC' is not providing volumes." \
             "Check the storage add-on (e.g. 'kubectl -n longhorn-system get pods'), or remove the default StorageClass annotation so SeaweedFS uses node storage, then install again."
    fi
    if [ -n "$SCHED" ] && [ $ELAPSED -ge 90 ] && ! echo "$SCHED" | grep -qi 'PersistentVolumeClaim'; then
        fail POD_UNSCHEDULABLE "No node can run SeaweedFS: $SCHED" "Free up CPU/memory (it needs 100m CPU and 256Mi memory) or check node taints, then install again."
    fi
    if [ $ELAPSED -ge 480 ]; then
        # Name the container that is not ready, and the last probe failure
        NOTREADY=$(kubectl -n $NS get pod "$POD" -o jsonpath='{range .status.containerStatuses[?(@.ready==false)]}{.name}{" "}{end}' 2>/dev/null || true)
        PROBE=$(kubectl -n $NS get events --field-selector "involvedObject.name=$POD,reason=Unhealthy" -o jsonpath='{.items[-1:].message}' 2>/dev/null | cut -c1-200 || true)
        echo "--- SeaweedFS log ---"; kubectl -n $NS logs "$POD" --all-containers --prefix --tail=15 2>/dev/null
        fail ADDON_TIMEOUT "SeaweedFS did not become ready within 8 minutes. Not ready: ${NOTREADY:-${WAITING:-starting}}${PROBE:+ — $PROBE}." "Check the log above ('kubectl -n seaweedfs logs deploy/seaweedfs --all-containers'), fix the cause, then use Repair."
    fi
    [ $((ELAPSED % 60)) -lt 10 ] && log "…still starting (${ELAPSED}s, pod: ${WAITING:-${POD:+creating}}${PVC:+, volume: $PVC})"
    sleep 10
done

log "Step 5/5: Creating bucket 'backups'..."
create_bucket() {
    kubectl -n $NS exec deploy/seaweedfs -c seaweedfs -- sh -c 'echo "s3.bucket.list" | weed shell 2>/dev/null' | grep -qw backups && return 0
    kubectl -n $NS exec deploy/seaweedfs -c seaweedfs -- sh -c 'echo "s3.bucket.create -name backups" | weed shell' 2>&1 | grep -qiE 'created|exist'
}
retry 6 create_bucket || log "Could not create the 'backups' bucket yet — create it later with any S3 client"

echo "✓ S3 Object Storage (SeaweedFS) installed"
echo ""
echo "S3 endpoint:  http://<node-ip>:$NODE_PORT   (region: us-east-1, path-style)"
echo "Web UI:       http://<node-ip>:$ADMIN_NODE_PORT   (user admin — password in the KubeEZ Add-ons panel)"
echo "Bucket:       backups"
echo "Credentials:  kubectl -n $NS get secret seaweedfs-s3 -o jsonpath='{.data.accessKey}' | base64 -d"
echo "Note: don't use this as THIS cluster's offsite etcd backup target — use it for other clusters or your apps."
echo "========================================="
