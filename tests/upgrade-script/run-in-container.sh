#!/bin/bash
# Runs backend/src/automation/upgrade-cluster.sh inside a throw-away Ubuntu
# container with stubbed kubeadm/kubectl/apt/systemctl/curl (see ./stubs).
# The stubs are steered by K_* variables, e.g. K_CGROUP=tmpfs simulates a
# cgroup-v1 node and K_APPLY_MSG=... makes 'kubeadm upgrade' fail with that text
# ("_" in K_APPLY_MSG / K_JOURNAL is turned into a space by the stub).
#
# usage (inside the container): run-in-container.sh "<K_*=...>" <upgrade-cluster.sh args...>
# prints:  EXIT=<code>  and the KUBEEZ_FAIL line (or NO_FAIL_LINE)
ENVS="$1"; shift
mkdir -p /tmp/st /etc/kubernetes /var/lib/kubelet /etc/containerd
touch /etc/kubernetes/admin.conf
echo 'sandbox_image = "registry.k8s.io/pause:3.9"' > /etc/containerd/config.toml
FLAGS='--pod-infra-container-image=registry.k8s.io/pause:3.9 --node-ip=1.2.3.4'
[ -n "$ONLY_REMOVED_FLAG" ] && FLAGS='--pod-infra-container-image=registry.k8s.io/pause:3.10'
echo "KUBELET_KUBEADM_ARGS=\"$FLAGS\"" > /var/lib/kubelet/kubeadm-flags.env
# Copy the stubs and make them executable (git on Windows may drop the +x bit)
mkdir -p /tmp/stubs && cp /stubs/* /tmp/stubs/ && chmod +x /tmp/stubs/*
# shellcheck disable=SC2086
env $ENVS PATH=/tmp/stubs:$PATH bash /upgrade-cluster.sh "$@" > /tmp/out.txt 2>&1
echo "EXIT=$?"
grep 'KUBEEZ_FAIL|' /tmp/out.txt || echo "NO_FAIL_LINE"
echo "PROGRESS=$(grep -oE 'KUBEEZ_PROGRESS\|[0-9]+' /tmp/out.txt | cut -d'|' -f2 | tr '\n' ',')"
echo "FLAGS_AFTER=$(cat /var/lib/kubelet/kubeadm-flags.env)"
echo "APPLY_RUNS=$(cat /tmp/st/apply_count 2>/dev/null || echo 0)"
[ -n "$SHOW_LOG" ] && cat /tmp/out.txt
exit 0
