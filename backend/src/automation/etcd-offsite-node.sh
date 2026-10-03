#!/bin/bash
# KubeEZ offsite etcd backups — installed on the primary control-plane as
# /usr/local/sbin/kubeez-etcd-offsite. Copies ENCRYPTED backup bundles straight
# from this node to S3 / MinIO / any S3-compatible storage (data never passes
# through the KubeEZ server).
#
# The node never receives the storage keys: KubeEZ sends short-lived PRESIGNED
# URLs (AWS SigV4, one per operation) and this script only runs plain curl.
#
# Usage:  <input on stdin> kubeez-etcd-offsite test|inventory|upload
#   test      → PUT/GET/DELETE a probe object (KZ_PUT, KZ_GET, KZ_DEL)
#   inventory → list local snapshots + offsite objects (KZ_LIST)
#   upload    → build + encrypt + PUT bundles (UPLOAD=<snapshot>|<url>, repeatable)
#               and delete expired offsite bundles (DELETE=<url>, repeatable)
#
# Input arrives on stdin (never on the command line) as KEY=<base64 value> lines.
# Bundle = etcd snapshot + /etc/kubernetes/pki + kubeadm config + MANIFEST,
# tar.gz, encrypted with AES-256 (openssl, PBKDF2). Decrypt with the recovery key:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:<KEY> -in X.tar.gz.enc | tar xz
#
# Every run ends with one machine line: OFFSITE_OK|... or OFFSITE_FAIL|CODE|reason
# KUBEEZ_ETCD_OFFSITE_SCRIPT_VERSION=2

set -o pipefail
export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH

MODE="${1:-}"
BK=/var/lib/etcd-backup
WORK="$BK/.offsite-tmp"

fail() { echo "OFFSITE_FAIL|$1|$(printf '%s' "$2" | tr '|\n' '/ ')"; rm -rf "$WORK"; exit 1; }

# ── Input from stdin ─────────────────────────────────────────────────────────
UPLOADS=(); DELETES=()
while IFS='=' read -r k v; do
    val="$(printf '%s' "$v" | base64 -d 2>/dev/null)"
    case "$k" in
        KZ_INSECURE|KZ_ENC_KEY|KZ_CLUSTER|KZ_PUT|KZ_GET|KZ_DEL|KZ_LIST|KZ_HOST) printf -v "$k" '%s' "$val" ;;
        UPLOAD) UPLOADS+=("$val") ;;
        DELETE) DELETES+=("$val") ;;
    esac
done
case "$MODE" in test|inventory|upload) ;; *) fail BAD_INPUT "Unknown mode '$MODE'." ;; esac

CURL=(curl -sS --retry 2 --connect-timeout 15)
[ "${KZ_INSECURE:-0}" = "1" ] && CURL+=(-k)
RESP=$(mktemp /tmp/kubeez-s3.XXXXXX)
trap 'rm -f "$RESP"' EXIT

# s3 <description> <curl args...> — run a request; on failure explain it and stop
s3() {
    local what="$1"; shift
    local code rc
    code=$("${CURL[@]}" -o "$RESP" -w '%{http_code}' "$@" 2>"$RESP.err"); rc=$?
    if [ $rc -ne 0 ]; then
        local err; err=$(cat "$RESP.err" 2>/dev/null); rm -f "$RESP.err"
        case $rc in
            6)  fail UNREACHABLE "This node cannot resolve ${KZ_HOST}. Check the endpoint and the node's DNS." ;;
            7|28) fail UNREACHABLE "This node cannot reach ${KZ_HOST} (${err}). Check the endpoint, port and firewall between the node and the storage." ;;
            35|51|58|60|77|83|90|91) fail TLS "TLS certificate problem talking to ${KZ_HOST}. For a self-signed MinIO certificate, enable 'Allow self-signed certificate'." ;;
            *)  fail STORAGE_ERROR "${what} failed: ${err:-curl exit $rc}" ;;
        esac
    fi
    rm -f "$RESP.err"
    case "$code" in 2??) return 0 ;; esac
    local s3code msg
    s3code=$(grep -oE '<Code>[^<]*</Code>' "$RESP" | head -1 | sed -E 's#</?Code>##g')
    msg=$(grep -oE '<Message>[^<]*</Message>' "$RESP" | head -1 | sed -E 's#</?Message>##g')
    # No S3 error document at all → this address is not an S3 API (a web UI,
    # a different service, a wrong port)
    if [ -z "$s3code" ] && { grep -qiE '<html|<!doctype' "$RESP" || [ "$code" = 404 ] || [ "$code" = 405 ]; }; then
        fail WRONG_ENDPOINT "${KZ_HOST} answered (HTTP ${code}), but it is not an S3 API — probably a web page or the wrong port. For KubeEZ's S3 add-on use its S3 endpoint (port 30833), not the web UI (30834)."
    fi
    case "$s3code" in
        NoSuchBucket) fail NO_BUCKET "The bucket does not exist. Create it first (or fix the name)." ;;
        InvalidAccessKeyId|SignatureDoesNotMatch) fail BAD_KEYS "The access key or secret key is wrong." ;;
        AccessDenied) fail ACCESS_DENIED "The keys work, but they are not allowed to do this (${what}). Grant s3:PutObject, s3:GetObject, s3:ListBucket and s3:DeleteObject on the bucket." ;;
        AuthorizationHeaderMalformed|PermanentRedirect|IllegalLocationConstraintException|AuthorizationQueryParametersError)
            fail WRONG_REGION "The bucket is in a different region than the one selected (${msg})." ;;
        RequestTimeTooSkewed) fail CLOCK_SKEW "The clock of the KubeEZ server or the storage is wrong (${msg})." ;;
        *) fail STORAGE_ERROR "${what} failed: HTTP ${code} ${s3code:-} ${msg:-}" ;;
    esac
}

# ── test ─────────────────────────────────────────────────────────────────────
if [ "$MODE" = "test" ]; then
    openssl enc -aes-256-cbc -pbkdf2 -iter 1000 -pass pass:x -in /dev/null -out /dev/null 2>/dev/null \
        || fail OPENSSL_OLD "This node's OpenSSL is too old for encrypted backups (needs 1.1.1+; CentOS/RHEL 7 is not supported)."
    TOKEN="kubeez-$(date +%s)-$RANDOM"
    printf '%s' "$TOKEN" > /tmp/kubeez-probe.txt
    s3 "Writing a test file" -T /tmp/kubeez-probe.txt "$KZ_PUT"
    s3 "Reading the test file back" "$KZ_GET"
    [ "$(cat "$RESP")" = "$TOKEN" ] || fail STORAGE_ERROR "Wrote a test file but read back different content."
    s3 "Deleting the test file" -X DELETE "$KZ_DEL"
    rm -f /tmp/kubeez-probe.txt
    echo "OFFSITE_OK|test"
    exit 0
fi

# ── inventory ────────────────────────────────────────────────────────────────
if [ "$MODE" = "inventory" ]; then
    for f in $(ls -1 "$BK"/*.db 2>/dev/null); do echo "LOCAL|$(basename "$f")"; done
    s3 "Listing the bucket" "$KZ_LIST"
    grep -oE '<Key>[^<]*</Key>' "$RESP" | sed -E 's#</?Key>##g' | while read -r key; do echo "REMOTE|$key"; done
    grep -q '<IsTruncated>true</IsTruncated>' "$RESP" && echo "TRUNCATED|1"
    echo "OFFSITE_OK|inventory"
    exit 0
fi

# ── upload ───────────────────────────────────────────────────────────────────
openssl enc -aes-256-cbc -pbkdf2 -iter 1000 -pass pass:x -in /dev/null -out /dev/null 2>/dev/null \
    || fail OPENSSL_OLD "This node's OpenSSL is too old for encrypted backups (needs 1.1.1+)."
[ -n "${KZ_ENC_KEY:-}" ] || fail BAD_INPUT "Missing encryption key."
export KZ_ENC_KEY
UPLOADED=0
for item in "${UPLOADS[@]}"; do
    snap="${item%%|*}"; url="${item#*|}"
    case "$snap" in */*|..*|"") fail BAD_INPUT "Invalid snapshot name '$snap'." ;; esac
    [ -f "$BK/$snap" ] || continue          # removed by retention meanwhile

    rm -rf "$WORK"; mkdir -p "$WORK/bundle"; chmod 700 "$WORK"
    cp "$BK/$snap" "$WORK/bundle/etcd-snapshot.db"
    [ -d /etc/kubernetes/pki ] && cp -a /etc/kubernetes/pki "$WORK/bundle/pki"
    KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n kube-system get cm kubeadm-config -o yaml > "$WORK/bundle/kubeadm-config.yaml" 2>/dev/null || true
    {
        echo "snapshot: $snap"
        echo "cluster: ${KZ_CLUSTER:-}"
        echo "node: $(hostname)"
        echo "kubeadm: $(kubeadm version -o short 2>/dev/null)"
        echo "created: $(date -u -r "$BK/$snap" +%Y-%m-%dT%H:%M:%SZ)"
    } > "$WORK/bundle/MANIFEST"
    # S3 needs a Content-Length, so encrypt to a file first (no chunked upload)
    tar -C "$WORK/bundle" -czf - . \
        | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:KZ_ENC_KEY -out "$WORK/bundle.enc" \
        || fail BUNDLE_FAILED "Could not build/encrypt the backup bundle for $snap (disk full?)."
    s3 "Uploading $snap" -T "$WORK/bundle.enc" "$url"
    rm -rf "$WORK"
    UPLOADED=$((UPLOADED + 1))
    echo "UPLOADED|$snap"
done

DELETED=0
for url in "${DELETES[@]}"; do
    s3 "Deleting an expired offsite backup" -X DELETE "$url"
    DELETED=$((DELETED + 1))
done

echo "OFFSITE_OK|upload|uploaded=$UPLOADED|deleted=$DELETED"
