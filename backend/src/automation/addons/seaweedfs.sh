#!/bin/bash
# KubeEZ - Install S3 Object Storage (SeaweedFS)
# Actively maintained, S3-compatible object storage for apps in the cluster —
# and a target for OTHER clusters' offsite etcd backups.
# (MinIO's open-source images are no longer published, so KubeEZ ships SeaweedFS.)
#
# - Single-pod "weed server" (master + volume + filer + S3 gateway)
# - S3 API with access/secret key auth on NodePort 30833 (only port exposed)
# - Data on the default StorageClass (e.g. Longhorn) if there is one,
#   otherwise a hostPath on one pinned node
# - Creates a "backups" bucket; credentials live in Secret seaweedfs/seaweedfs-s3
# - Idempotent: re-running keeps the existing credentials and data

set -eo pipefail

KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/snap/bin

NS=seaweedfs
IMAGE=chrislusf/seaweedfs:4.48
NODE_PORT=30833
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
EOF

log "Step 4/5: Waiting for SeaweedFS to be ready..."
retry 3 kubectl rollout status deployment/seaweedfs -n $NS --timeout=300s

log "Step 5/5: Creating bucket 'backups'..."
create_bucket() {
    kubectl -n $NS exec deploy/seaweedfs -- sh -c 'echo "s3.bucket.list" | weed shell 2>/dev/null' | grep -qw backups && return 0
    kubectl -n $NS exec deploy/seaweedfs -- sh -c 'echo "s3.bucket.create -name backups" | weed shell' 2>&1 | grep -qiE 'created|exist'
}
retry 6 create_bucket || log "Could not create the 'backups' bucket yet — create it later with any S3 client"

echo "✓ S3 Object Storage (SeaweedFS) installed"
echo ""
echo "S3 endpoint:  http://<node-ip>:$NODE_PORT   (region: us-east-1, path-style)"
echo "Bucket:       backups"
echo "Credentials:  kubectl -n $NS get secret seaweedfs-s3 -o jsonpath='{.data.accessKey}' | base64 -d"
echo "Note: don't use this as THIS cluster's offsite etcd backup target — use it for other clusters or your apps."
echo "========================================="
