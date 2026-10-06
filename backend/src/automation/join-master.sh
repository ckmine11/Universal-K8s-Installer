#!/bin/bash
set -e

# =========================================
# Join Additional Control Plane Node
# =========================================
# This script joins a new node to an existing Kubernetes cluster as an additional control plane (HA master)
# Arguments:
#   $1: Join command (from kubeadm token create)
#   $2: Certificate key (for control plane join)
#   $3: Control-plane virtual IP (optional, kube-vip)
#   $4: This node's IP (needed with $3: picks the interface for the VIP)

JOIN_COMMAND="$1"
CERT_KEY="$2"
VIP="${3:-}"
NODE_IP="${4:-}"

# kube-vip: a floating virtual IP (VIP) for the Kubernetes API, held by one
# healthy control-plane at a time (ARP + leader election). Runs as a static pod.
# write_kube_vip <vip> <node-ip> <kubeconfig-on-host>
KUBE_VIP_IMAGE="ghcr.io/kube-vip/kube-vip:v1.2.4"
write_kube_vip() {
    local vip="$1" node_ip="$2" kubeconfig="$3" iface
    iface=$(ip -o -4 addr show | awk -v ip="$node_ip" '{split($4, a, "/"); if (a[1] == ip) {print $2; exit}}')
    if [ -z "$iface" ]; then
        echo "KUBEEZ_FAIL|VIP_NO_INTERFACE|No network interface on this node has the address $node_ip.|Use the node's own LAN address for this control-plane."
        exit 1
    fi
    echo "kube-vip: VIP $vip on interface $iface (node $node_ip)"
    crictl --runtime-endpoint unix:///var/run/containerd/containerd.sock pull "$KUBE_VIP_IMAGE" >/dev/null 2>&1 \
        || ctr -n k8s.io images pull "$KUBE_VIP_IMAGE" >/dev/null 2>&1 \
        || echo "warning: could not pre-pull $KUBE_VIP_IMAGE — the kubelet will try again"
    mkdir -p /etc/kubernetes/manifests
    cat > /etc/kubernetes/manifests/kube-vip.yaml <<KVEOF
apiVersion: v1
kind: Pod
metadata:
  name: kube-vip
  namespace: kube-system
  labels:
    app.kubernetes.io/managed-by: kubeez
spec:
  containers:
  - args:
    - manager
    env:
    - name: vip_arp
      value: "true"
    - name: port
      value: "6443"
    - name: vip_nodename
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    - name: vip_interface
      value: $iface
    - name: vip_subnet
      value: "32"
    - name: dns_mode
      value: first
    - name: cp_enable
      value: "true"
    - name: cp_namespace
      value: kube-system
    - name: vip_leaderelection
      value: "true"
    - name: vip_leasename
      value: plndr-cp-lock
    - name: vip_leaseduration
      value: "15"
    - name: vip_renewdeadline
      value: "10"
    - name: vip_retryperiod
      value: "2"
    - name: address
      value: "$vip"
    image: $KUBE_VIP_IMAGE
    imagePullPolicy: IfNotPresent
    name: kube-vip
    securityContext:
      capabilities:
        add:
        - NET_ADMIN
        - NET_RAW
        drop:
        - ALL
    volumeMounts:
    - mountPath: /etc/kubernetes/admin.conf
      name: kubeconfig
  hostAliases:
  - hostnames:
    - kubernetes
    ip: 127.0.0.1
  hostNetwork: true
  priorityClassName: system-node-critical
  volumes:
  - hostPath:
      path: $kubeconfig
    name: kubeconfig
KVEOF
    chmod 600 /etc/kubernetes/manifests/kube-vip.yaml
}

echo "========================================="
echo "Joining as Additional Control Plane..."
echo "========================================="

# Clean up any previous cluster state
echo "Cleaning up control plane node and killing port usage..."
kubeadm reset -f 2>/dev/null || true
systemctl stop kubelet 2>/dev/null || true
rm -rf /etc/kubernetes/* /var/lib/etcd/* /var/lib/kubelet/* 2>/dev/null || true
rm -rf /etc/cni/net.d/* 2>/dev/null || true
ip link delete cni0 2>/dev/null || true
ip link delete flannel.1 2>/dev/null || true
iptables -F && iptables -t nat -F && iptables -t mangle -F && iptables -X 2>/dev/null || true
conntrack -F 2>/dev/null || true
# A previous attempt's kube-vip may have left the VIP on this node — the
# join must reach the real holder
if [ -n "$VIP" ]; then
    ip -o -4 addr show | awk -v v="$VIP" '{split($4, a, "/"); if (a[1] == v) print $2}' | while read -r dev; do
        ip addr del "$VIP/32" dev "$dev" 2>/dev/null || true
    done
fi

# Execute join command with control-plane flag
echo "Executing join command for control plane..."
# Ensure join command is not empty
if [ -z "$JOIN_COMMAND" ]; then
    echo "Error: JOIN_COMMAND is empty"
    exit 1
fi

# Parse join command into array — avoids unquoted expansion and prevents injection
read -ra JOIN_ARGS <<< "$JOIN_COMMAND"
"${JOIN_ARGS[@]}" --control-plane --certificate-key "$CERT_KEY" --ignore-preflight-errors=NumCPU,Mem

# This control-plane can hold the VIP too (takes over if the holder dies)
if [ -n "$VIP" ] && [ -n "$NODE_IP" ]; then
    write_kube_vip "$VIP" "$NODE_IP" /etc/kubernetes/admin.conf
    echo "✓ kube-vip installed: this node can take over $VIP"
fi

# Wait for kubelet to start
echo "Waiting for kubelet to start..."
sleep 5

# Configure kubectl for this master node
echo "Configuring kubectl..."
mkdir -p $HOME/.kube
cp -f /etc/kubernetes/admin.conf $HOME/.kube/config
chown $(id -u):$(id -g) $HOME/.kube/config

# Verify node joined successfully
echo "Verifying control plane node status..."
kubectl get nodes

echo "✓ Control plane node joined successfully"
