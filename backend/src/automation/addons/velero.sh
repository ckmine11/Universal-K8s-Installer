#!/bin/bash
# KubeEZ - Install Velero (volume DATA + Kubernetes object backups)
#
# etcd snapshots hold the cluster's objects but never the files inside
# persistent volumes (databases, uploads). Velero copies those files (file
# system backup with Kopia, through the node-agent DaemonSet) together with the
# namespace's objects to S3-compatible storage, and restores them.
#
# The storage settings come from KubeEZ (Backups → Volume Backups): KubeEZ
# writes them to /etc/kubeez/velero.env (root only) right before this script
# runs; the script moves the keys into the cluster Secret velero/cloud-credentials
# and deletes the file.
#
# Re-running (repair / changed settings) updates the credentials and the backup
# location in place — existing backups stay where they are.
# Failures end with KUBEEZ_FAIL|CODE|reason|fix.

set -o pipefail
KUBECONFIG=${1:-"/etc/kubernetes/admin.conf"}
export KUBECONFIG
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin

VELERO_VERSION=${VELERO_VERSION:-v1.18.4}
AWS_PLUGIN=${VELERO_AWS_PLUGIN:-velero/velero-plugin-for-aws:v1.14.4}
CFG=/etc/kubeez/velero.env
CREDS=/etc/kubeez/velero-credentials

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { rm -f "$CFG" "$CREDS"; echo "KUBEEZ_FAIL|$1|$(printf '%s' "$2" | tr '|\n' '/ ')|$(printf '%s' "$3" | tr '|\n' '/ ')"; exit 1; }
progress() { echo "KUBEEZ_PROGRESS|$1|$2"; }

echo "========================================="
echo "Installing Velero ${VELERO_VERSION} (volume backups)"
echo "========================================="

[ -f "$CFG" ] || fail NOT_CONFIGURED "Volume backups have no storage settings yet." \
    "Open the cluster's Backups tab → Volume Backups, save where backups should go, then install again."
# split at the FIRST '=' only: 'IFS== read' would drop a trailing '=' (base64 padding)
while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in VB_PROVIDER|VB_ENDPOINT|VB_REGION|VB_BUCKET|VB_PREFIX|VB_ACCESS|VB_SECRET|VB_INSECURE)
        printf -v "$k" '%s' "$(printf '%s' "$v" | base64 -d 2>/dev/null)" ;;
    esac
done < "$CFG"
[ -n "${VB_BUCKET:-}" ] && [ -n "${VB_ACCESS:-}" ] && [ -n "${VB_SECRET:-}" ] \
    || fail NOT_CONFIGURED "The volume backup settings are incomplete (bucket or keys missing)." "Save the settings again under Backups → Volume Backups."

# ── 1. Velero CLI on this control-plane (KubeEZ drives Velero through it) ────
progress 10 "Installing the Velero CLI"
A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64
if ! velero version --client-only 2>/dev/null | grep -q "$VELERO_VERSION"; then
    log "Downloading the Velero CLI ${VELERO_VERSION}..."
    T=$(mktemp -d)
    curl -fsSL --retry 3 -m 300 "https://github.com/velero-io/velero/releases/download/${VELERO_VERSION}/velero-${VELERO_VERSION}-linux-${A}.tar.gz" -o "$T/v.tgz" \
        || fail NO_INTERNET "Could not download the Velero CLI from github.com." "Allow this control-plane to reach github.com (and release-assets.githubusercontent.com), then retry."
    tar xzf "$T/v.tgz" -C "$T" && install -m0755 "$T/velero-${VELERO_VERSION}-linux-${A}/velero" /usr/local/bin/velero \
        || fail NO_INTERNET "The Velero download was damaged." "Retry the install."
    rm -rf "$T"
fi
log "✓ $(velero version --client-only 2>/dev/null | grep -m1 Version | xargs)"

# ── 2. Credentials + backup location settings ────────────────────────────────
umask 077
printf '[default]\naws_access_key_id=%s\naws_secret_access_key=%s\n' "$VB_ACCESS" "$VB_SECRET" > "$CREDS"
rm -f "$CFG"
BSL="region=${VB_REGION:-us-east-1}"
if [ "${VB_PROVIDER:-aws}" != "aws" ]; then
    BSL="$BSL,s3ForcePathStyle=true,s3Url=${VB_ENDPOINT}"
fi
[ "${VB_INSECURE:-0}" = "1" ] && BSL="$BSL,insecureSkipTLSVerify=true"
log "Backups go to bucket '${VB_BUCKET}', folder '${VB_PREFIX}' (${VB_ENDPOINT:-AWS S3 ${VB_REGION}})"

# ── 3. Install (or update) Velero + the node-agent that copies volume files ──
progress 25 "Installing Velero and the node-agent"
OUT=$(velero install \
    --provider aws \
    --plugins "$AWS_PLUGIN" \
    --bucket "$VB_BUCKET" \
    --prefix "$VB_PREFIX" \
    --secret-file "$CREDS" \
    --backup-location-config "$BSL" \
    --use-volume-snapshots=false \
    --use-node-agent \
    --default-volumes-to-fs-backup 2>&1)
RC=$?
echo "$OUT" | grep -vE '^(CustomResourceDefinition|Waiting for|.*already exists, proceeding)' | tail -8 | sed 's/^/  /'
[ $RC -eq 0 ] || fail INSTALL_FAILED "velero install failed: $(echo "$OUT" | tail -1)" "Check the log above, then retry."

# Re-runs: 'velero install' keeps existing objects — apply the new settings explicitly
kubectl -n velero create secret generic cloud-credentials --from-file=cloud="$CREDS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
rm -f "$CREDS"
CFGJSON=$(printf '%s' "$BSL" | awk -F, '{printf "{"; for(i=1;i<=NF;i++){split($i,kv,"="); printf "%s\"%s\":\"%s\"", (i>1?",":""), kv[1], substr($i, length(kv[1])+2)} printf "}"}')
kubectl -n velero patch backupstoragelocation default --type merge \
    -p "{\"spec\":{\"objectStorage\":{\"bucket\":\"${VB_BUCKET}\",\"prefix\":\"${VB_PREFIX}\"},\"config\":${CFGJSON}}}" >/dev/null 2>&1 || true
kubectl -n velero rollout restart deploy/velero >/dev/null 2>&1
kubectl -n velero rollout restart ds/node-agent >/dev/null 2>&1

progress 55 "Waiting for Velero to start"
kubectl -n velero rollout status deploy/velero --timeout=600s 2>&1 | tail -1 | sed 's/^/  /' \
    || fail NOT_READY "Velero did not start within 10 minutes." "kubectl -n velero describe pod -l deploy=velero  (image pull? not enough memory?)"
kubectl -n velero rollout status ds/node-agent --timeout=600s 2>&1 | tail -1 | sed 's/^/  /' \
    || fail NOT_READY "The Velero node-agent did not start on every node within 10 minutes." "kubectl -n velero get pods -l name=node-agent -o wide"

# ── 4. Can Velero reach the storage? ─────────────────────────────────────────
progress 80 "Checking the backup storage"
PHASE=""
for _ in $(seq 1 36); do
    PHASE=$(kubectl -n velero get backupstoragelocation default -o jsonpath='{.status.phase}' 2>/dev/null)
    [ "$PHASE" = "Available" ] && break
    sleep 5
done
if [ "$PHASE" != "Available" ]; then
    MSG=$(kubectl -n velero get backupstoragelocation default -o jsonpath='{.status.message}' 2>/dev/null)
    [ -z "$MSG" ] && MSG=$(kubectl -n velero logs deploy/velero --tail=200 2>/dev/null | grep -iE 'backup storage location|error' | tail -1)
    fail STORAGE_UNAVAILABLE "Velero is running but cannot use the storage: ${MSG:-no answer}" \
        "Check endpoint, bucket and keys under Backups → Volume Backups (the bucket must exist; the cluster nodes must reach the endpoint), save, then Repair."
fi
log "✓ Backup storage available"

progress 100 "Velero ready"
echo "✓ Velero installed — volume data of every pod is backed up with the namespace (file system backup)"
echo "========================================="
