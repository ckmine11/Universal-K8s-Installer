#!/bin/bash
# Scenario tests for upgrade-cluster.sh: every known failure must stop with the
# right KUBEEZ_FAIL code, and every happy path must succeed. Needs Docker only.
#
#   bash tests/upgrade-script/scenarios.sh
set -uo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: don't rewrite container paths

HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
SCRIPT="$(cd "$(dirname "$0")/../../backend/src/automation" && (pwd -W 2>/dev/null || pwd))/upgrade-cluster.sh"
IMAGE="${UPGRADE_TEST_IMAGE:-ubuntu:22.04}"
PASS=0; FAIL=0

# scenario <name> <K_* env> <expected: OK|FAIL_CODE> <extra grep or -> <upgrade-cluster.sh args...>
scenario() {
    local name="$1" envs="$2" expect="$3" extra="$4"; shift 4
    local out
    out=$(docker run --rm -e ONLY_REMOVED_FLAG="${ONLY_REMOVED_FLAG:-}" \
        -v "$HERE/stubs:/stubs:ro" -v "$HERE/run-in-container.sh:/run.sh:ro" -v "$SCRIPT:/upgrade-cluster.sh:ro" \
        "$IMAGE" bash /run.sh "$envs" "$@" 2>&1)
    local got
    if echo "$out" | grep -q '^EXIT=0'; then got=OK; else got=$(echo "$out" | grep -oE 'KUBEEZ_FAIL\|[A-Z_0-9]+' | head -1 | cut -d'|' -f2); fi
    local ok=1
    [ "$got" = "$expect" ] || ok=0
    if [ "$extra" != "-" ] && ! echo "$out" | grep -qE "$extra"; then ok=0; fi
    if [ $ok = 1 ]; then
        PASS=$((PASS + 1)); printf '  ✓ %-55s %s\n' "$name" "$got"
    else
        FAIL=$((FAIL + 1)); printf '  ✗ %-55s expected %s, got %s\n' "$name" "$expect" "${got:-nothing}"
        echo "$out" | sed 's/^/      /' | tail -15
    fi
}

docker pull -q "$IMAGE" >/dev/null

echo "Preflight (read-only check mode)"
scenario "node ready for 1.35"                    "X=1"                                     OK                    -   1.35.0 master true check
scenario "cgroups v1 blocked on 1.35"             "K_CGROUP=tmpfs"                          CGROUP_V1             -   1.35.0 master true check
scenario "CentOS 7 kernel blocked on 1.35"        "K_KERNEL=3.10.0-1160.el7"                KERNEL_UNSUPPORTED    -   1.35.0 master true check
scenario "1.36 + containerd 1.7 passes (auto-upgrade)" "K_CTR=1.7.27 K_SERVER_MINOR=35 K_PKGVER=1.36.0" OK     -   1.36.0 master true check
scenario "unreleased version blocked"             "K_REPO=404 K_SERVER_MINOR=36"            VERSION_NOT_PUBLISHED -   1.37.0 master true check
scenario "published version found in a >64 KB index" "K_BIGINDEX=1 K_SERVER_MINOR=34 K_PKGVER=1.35.0" OK - 1.35.0 master true check
scenario "missing version detected in a >64 KB index" "K_BIGINDEX=1 K_SERVER_MINOR=34 K_PKGVER=1.35.1" VERSION_NOT_AVAILABLE - 1.35.0 master true check
scenario "missing patch version blocked"          "K_PKGVER=1.35.1"                         VERSION_NOT_AVAILABLE -   1.35.0 master true check
scenario "registry unreachable"                   "K_REG=000"                               REGISTRY_UNREACHABLE  -   1.35.0 master true check
scenario "skip-level 1.33 → 1.35 blocked"         "K_SERVER_MINOR=33"                       SKIP_LEVEL            -   1.35.0 master true check
scenario "disk almost full"                       "K_DISK=900"                              DISK_FULL             -   1.35.0 master true check
scenario "API server unhealthy"                   "K_READYZ=fail"                           CLUSTER_UNHEALTHY     -   1.35.0 master true check
scenario "check mode emits no progress"           "X=1"                                     OK                    '^PROGRESS=$' 1.35.0 master true check

echo "Upgrade (full run)"
scenario "1.34 → 1.35 primary master"            "X=1"                                     OK  'PROGRESS=5,8,15,30,40,55,78,85,92,100,'  1.35.0 master true
scenario "1.35 worker"                            "X=1"                                     OK                    -   1.35.0 worker false
scenario "1.36: containerd 1.7 upgraded to 2.x"   "K_CTR=1.7.27 K_SERVER_MINOR=35 K_PKGVER=1.36.0" OK              -   1.36.0 master true
scenario "containerd stays 1.7 → clear reason"    "K_CTR=1.7.27 K_CTR_AFTER=1.7.30 K_SERVER_MINOR=35 K_PKGVER=1.36.0" CONTAINERD_TOO_OLD - 1.36.0 master true
scenario "1.36 → 1.37"                            "K_SERVER_MINOR=36 K_PKGVER=1.37.0"       OK                    -   1.37.0 master true
scenario "kubeadm timeout once → auto-retry"      "K_APPLY_MSG=context_deadline_exceeded K_APPLY_FAILS=1" OK 'APPLY_RUNS=2' 1.35.0 master true
scenario "etcd timeout twice → reason"            "K_APPLY_MSG=[upgrade/etcd]_timed_out_waiting_for_the_condition_etcd" ETCD_UPGRADE_TIMEOUT - 1.35.0 master true
scenario "image pull failure inside kubeadm"      "K_APPLY_MSG=error:_failed_to_pull_image_registry.k8s.io/etcd" IMAGE_PULL_FAILED - 1.35.0 master true
scenario "kubeadm preflight [ERROR]"              "K_APPLY_MSG=[preflight]_Some_fatal_errors_occurred:_[ERROR_X]:_bad" KUBEADM_PREFLIGHT - 1.35.0 master true
scenario "expired certificate"                    "K_APPLY_MSG=error:_x509:_certificate_has_expired" CERTIFICATE_ERROR - 1.35.0 master true
scenario "stale kubeadm-config version"          "K_APPLY_MSG=[upgrade]_FATAL:_this_version_of_kubeadm_only_supports_deploying_clusters_with_the_control_plane_version_1.36.0._Current_version:_v1.35.0" KUBEADM_CONFIG_STALE - 1.35.0 master true
scenario "API timeout (config map) once → auto-retry"   "K_APPLY_MSG=error:_[upgrade]_FATAL:_failed_to_get_config_map:_Get_https://192.168.220.80:6443/api/v1/namespaces/kube-system/configmaps/kubeadm-config:_net/http:_request_canceled_Client.Timeout_exceeded_while_awaiting_headers K_APPLY_FAILS=1" OK 'APPLY_RUNS=2' 1.35.0 master true
scenario "API timeout twice → reason, cluster unchanged" "K_APPLY_MSG=error:_[upgrade]_FATAL:_failed_to_get_config_map:_Get_https://192.168.220.80:6443/api/v1/namespaces/kube-system/configmaps/kubeadm-config:_net/http:_request_canceled_Client.Timeout_exceeded_while_awaiting_headers" API_SERVER_DOWN 'cluster is unchanged' 1.35.0 master true
scenario "kubelet rejects old flag"               "K_KUBELET_ACTIVE=3 K_JOURNAL=E1_unknown_flag:_--x" KUBELET_FLAG -          1.35.0 master true
scenario "apt cannot install kubeadm"             "K_APT_FAIL=1"                            PKG_INSTALL_FAILED    -   1.35.0 master true
scenario "image pre-pull fails"                   "K_PULL=1"                                IMAGE_PULL_FAILED     -   1.35.0 master true
ONLY_REMOVED_FLAG=1 scenario "kubeadm-flags.env with only removed flag repaired" "K_REAL_ENVCHECK=1" OK 'FLAGS_AFTER=KUBELET_KUBEADM_ARGS="--node-ip=' 1.35.0 master true

echo
echo "upgrade-cluster.sh scenarios: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
