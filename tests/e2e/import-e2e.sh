#!/bin/bash
# Connected clusters end to end: a real k3s and a throwaway self-hosted KubeEZ
# (the backend image) on their own Docker network, then tests/e2e/import-check.mjs.
#   docker compose build backend && bash tests/e2e/import-e2e.sh
# Leaves nothing behind (KEEP=1 keeps the containers for a look).
set -u
cd "$(dirname "$0")/../.."
NET=kz-e2e-import
K3S=kz-e2e-k3s
KZ=kz-e2e-kubeez
IMAGE=${KUBEEZ_IMAGE:-kubeez-backend}
PORT=${E2E_PORT:-3199}
TMP=$(mktemp -d)
export MSYS_NO_PATHCONV=1
cleanup() { [ "${KEEP:-}" = 1 ] && return; docker rm -f $K3S $KZ >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
cleanup; mkdir -p "$TMP"

docker network create $NET >/dev/null
echo "== k3s"
docker run -d --name $K3S --privileged --network $NET --memory 1500m rancher/k3s:v1.31.4-k3s1 server --tls-san $K3S --disable traefik >/dev/null
for i in $(seq 1 60); do docker exec $K3S kubectl get nodes 2>/dev/null | grep -q " Ready" && break; sleep 3; done
docker exec $K3S kubectl get nodes | tail -1
docker exec $K3S sh -c "sed 's#https://127.0.0.1:6443#https://$K3S:6443#' /etc/rancher/k3s/k3s.yaml" > "$TMP/kubeconfig"
docker exec $K3S sh -c "kubectl create ns shop >/dev/null; kubectl -n shop create deployment web --image=nginx:1.27-alpine >/dev/null"
echo "== KubeEZ (self-hosted, its own empty data)"
docker run -d --name $KZ --network $NET -p $PORT:3000 -e NODE_ENV=development -e PORT=3000 -e KUBEEZ_MODE=selfhosted -e APP_SECRET=e2e-only-secret-0123456789abcdef0123456789abcdef "$IMAGE" >/dev/null
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 2; done
KZIP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" $KZ)
KC=$TMP/kubeconfig
command -v cygpath >/dev/null 2>&1 && KC=$(cygpath -w "$KC")
KUBEEZ_URL="http://127.0.0.1:$PORT" KUBEEZ_INNER_URL="http://$KZIP:3000" E2E_NET=$NET E2E_KUBECONFIG="$KC" node tests/e2e/import-check.mjs
RC=$?
[ $RC -ne 0 ] && docker logs $KZ 2>&1 | tail -30
exit $RC
