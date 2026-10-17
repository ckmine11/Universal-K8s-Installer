#!/bin/bash
# KubeEZ AI without internet (air-gapped networks).
#
# On a machine WITH internet (and Docker):
#   ./ai-offline.sh export qwen2.5:3b                 → kubeez-ai-qwen2.5-3b.tar (the model, ~2 GB)
#   docker save ollama/ollama:0.40.5 -o ollama-image.tar   (the engine image, if the server lacks it)
# Carry the files over, then on the KubeEZ server (no internet needed):
#   docker load -i ollama-image.tar                   (only if the image is not there yet)
#   ./ai-offline.sh import kubeez-ai-qwen2.5-3b.tar   → into the KubeEZ server model
# Or into the KubeEZ AI add-on of a cluster (installed with "Download the model now" off):
#   ./ai-offline.sh import-cluster kubeez-ai-qwen2.5-3b.tar [--kubeconfig FILE]
# Other:
#   ./ai-offline.sh export-running [file]             → every model the KubeEZ server has now
#   ./ai-offline.sh list                              → the models of the KubeEZ server
set -euo pipefail
export MSYS_NO_PATHCONV=1
IMG="${OLLAMA_IMAGE:-ollama/ollama:0.40.5}"
CONTAINER="${KUBEEZ_OLLAMA_CONTAINER:-kubeez-ollama}"
die() { echo "✗ $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed"; }
model_volume() {
    [ -n "${VOLUME:-}" ] && { echo "$VOLUME"; return; }
    local v; v=$(docker volume ls -q | grep -E '(^|_)kubeez-ai-models$' | head -1)
    [ -n "$v" ] || die "No kubeez-ai-models volume — start KubeEZ with docker compose first (it creates it)"
    echo "$v"
}
fname() { echo "kubeez-ai-$(echo "$1" | tr ':/' '--').tar"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  export)
    need docker
    MODEL="${1:?usage: ai-offline.sh export MODEL [FILE]}"; FILE="${2:-$(fname "$MODEL")}"
    TMP="kz-ai-export-$$"
    trap 'docker rm -f "$TMP" >/dev/null 2>&1; docker volume rm -f "$TMP" >/dev/null 2>&1' EXIT
    docker volume create "$TMP" >/dev/null
    docker run -d --name "$TMP" -v "$TMP":/root/.ollama "$IMG" >/dev/null
    for _ in $(seq 1 30); do docker exec "$TMP" ollama list >/dev/null 2>&1 && break; sleep 1; done
    echo "• downloading $MODEL …"
    docker exec "$TMP" ollama pull "$MODEL"
    docker exec "$TMP" tar -C /root/.ollama -cf - models > "$FILE"
    echo "✓ $FILE ($(du -h "$FILE" | cut -f1)) — carry it to the KubeEZ server and run: ./ai-offline.sh import $FILE"
    ;;
  export-running)
    need docker
    FILE="${1:-kubeez-ai-models.tar}"
    docker run --rm -v "$(model_volume)":/root/.ollama --entrypoint tar "$IMG" -C /root/.ollama -cf - models > "$FILE"
    echo "✓ $FILE ($(du -h "$FILE" | cut -f1))"
    ;;
  import)
    need docker
    FILE="${1:?usage: ai-offline.sh import FILE}"; [ -f "$FILE" ] || die "No file $FILE"
    tar -tf "$FILE" | grep -qE '^models/manifests(-v2)?/' || die "$FILE is not a KubeEZ AI model bundle (no models/manifests inside)"
    docker image inspect "$IMG" >/dev/null 2>&1 || die "The image $IMG is not on this server — docker load it first (see the top of this script)"
    VOL=$(model_volume)
    docker run --rm -i -v "$VOL":/root/.ollama --entrypoint tar "$IMG" -C /root/.ollama -xf - < "$FILE"
    echo "✓ imported into the volume $VOL"
    if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
        docker restart "$CONTAINER" >/dev/null
        for _ in $(seq 1 30); do docker exec "$CONTAINER" ollama list >/dev/null 2>&1 && break; sleep 1; done
        docker exec "$CONTAINER" ollama list
        echo "✓ KubeEZ AI can use it now (Settings → AI → the server model → Test)"
    fi
    ;;
  import-cluster)
    need kubectl
    FILE="${1:?usage: ai-offline.sh import-cluster FILE [--kubeconfig F]}"; shift
    [ -f "$FILE" ] || die "No file $FILE"
    KC=(); [ "${1:-}" = "--kubeconfig" ] && KC=(--kubeconfig "$2")
    POD=$(kubectl "${KC[@]}" -n kubeez-ai get pod -l app.kubernetes.io/instance=kubeez-ai -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    [ -n "$POD" ] || die "The KubeEZ AI add-on is not running on this cluster (namespace kubeez-ai)"
    echo "• copying into $POD …"
    kubectl "${KC[@]}" -n kubeez-ai exec -i "$POD" -- tar -C /root/.ollama -xf - < "$FILE"
    kubectl "${KC[@]}" -n kubeez-ai exec "$POD" -- ollama list
    echo "✓ imported — KubeEZ AI can use it now"
    ;;
  list)
    need docker
    docker exec "$CONTAINER" ollama list
    ;;
  *)
    sed -n '2,17p' "$0"; exit 1
    ;;
esac
