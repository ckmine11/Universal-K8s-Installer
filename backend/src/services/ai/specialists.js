// Specialists — the incident explainer thinks like the right expert: each one
// collects the evidence its area needs (read-only kubectl) and brings its own
// checklist. Picked from the incident and what the logs say.
const K = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 20 kubectl'
const NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const ok = (s) => NAME.test(String(s || ''))

export const SPECIALISTS = {
    controlPlane: {
        label: 'Control-plane specialist',
        prompt: 'Think like a Kubernetes control-plane expert. Check in this order: etcd health and its disk (space, latency), certificate expiry (kubeadm certs), the static pods (kube-apiserver, controller-manager, scheduler, etcd) and their restarts, time sync between control-planes. Never suggest deleting etcd data or "kubeadm reset" on a working control-plane — restoring a snapshot is the safe path.',
        async collect(run) {
            await run('control-plane pods', `${K} -n kube-system get pods -l tier=control-plane -o wide 2>&1 | head -20`)
            await run('certificates', 'sudo kubeadm certs check-expiration 2>&1 | head -25')
            await run('etcd disk', 'df -h /var/lib/etcd 2>&1; sudo du -sh /var/lib/etcd 2>/dev/null')
        }
    },
    storage: {
        label: 'Storage specialist',
        prompt: 'Think like a Kubernetes storage expert. Check in this order: is there a (default) StorageClass and does its provisioner run, the claim (size, access mode — ReadWriteMany needs NFS-like storage), binding mode (WaitForFirstConsumer waits for a pod), mount/attach errors (Multi-Attach, read-only file system, no space left), the volume\'s node. Never suggest deleting a PersistentVolume or PVC that holds data.',
        async collect(run, inc) {
            const ns = ok(inc.namespace) ? inc.namespace : null
            if (ns) await run('claims', `${K} -n ${ns} get pvc -o wide 2>&1 | head -20`)
            await run('storage classes', `${K} get storageclass 2>&1`)
            await run('provisioner pods', `${K} get pods -A -o wide 2>&1 | grep -Ei 'longhorn-(manager|csi)|nfs|csi-|provisioner' | head -15`)
            if (ns) await run('mount events', `${K} -n ${ns} get events --field-selector type=Warning 2>&1 | grep -Ei 'mount|attach|volume|provision' | tail -10`)
        }
    },
    network: {
        label: 'Networking specialist',
        prompt: 'Think like a Kubernetes networking expert. Check in this order: DNS (is the name right, do the CoreDNS pods run), the Service (does its selector match ready pods — look at the endpoints), the port (Service port vs containerPort vs what the app listens on), NetworkPolicies that block the traffic, then the CNI and kube-proxy pods. "connection refused" means nothing listens there; "i/o timeout" means traffic is dropped; "no such host" is DNS.',
        async collect(run, inc) {
            const ns = ok(inc.namespace) ? inc.namespace : null
            if (ns) await run('services and endpoints', `${K} -n ${ns} get svc,endpoints -o wide 2>&1 | head -30`)
            if (ns) await run('network policies', `${K} -n ${ns} get networkpolicy 2>&1 | head -10`)
            await run('DNS and network pods', `${K} -n kube-system get pods -o wide 2>&1 | grep -Ei 'coredns|kube-proxy|flannel|calico|cilium|weave|kube-router' | head -20`)
        }
    },
    node: {
        label: 'Node specialist',
        prompt: 'Think like a Linux and kubelet expert. Check in this order: the node conditions (Ready, Disk/Memory/PID pressure), what fills the disk (images, logs, /var/lib/containerd), the kubelet and container runtime, then which pods were evicted. Freeing space (crictl rmi --prune, journal vacuum) is safe; never suggest formatting a disk or "kubeadm reset" on a node that is part of the cluster.',
        async collect(run, inc) {
            if (ok(inc.nodeName || inc.target)) await run('pods on the node', `${K} get pods -A --field-selector spec.nodeName=${inc.nodeName || inc.target} -o wide 2>&1 | head -30`)
            await run('recent node events', `${K} get events -A --field-selector involvedObject.kind=Node 2>&1 | tail -12`)
        }
    },
    app: {
        label: 'Application specialist',
        prompt: 'Think like an experienced SRE debugging an application on Kubernetes. Check in this order: the previous container log (the real error is usually the first error before it exits), the exit code (137 = killed for memory, 1 = app error), configuration (env vars, ConfigMaps, Secrets, mounted files), probes (port and path match what the app serves), resource limits, and dependencies it calls (database, API).',
        async collect() { }
    }
}

const NETWORK_TEXT = /no such host|i\/o timeout|connection (refused|reset|timed out)|dial tcp|network is unreachable|could not resolve|name resolution|503 service unavailable|upstream connect error|tls handshake timeout/i
const STORAGE_TEXT = /persistentvolumeclaim|multi-attach|failedmount|failedattach|read-only file system|no space left on device|unbound immediate|volume .* not found|failed to provision/i

/** Which specialist fits this incident (and what the logs say). */
export function pickSpecialist(inc, text = '') {
    const all = `${inc.message || ''}\n${text}`
    if (inc.category === 'control-plane' || ['EtcdUnhealthy', 'CertExpiring', 'ControlPlaneDown', 'ControlPlaneDiskFull'].includes(inc.reason)) return 'controlPlane'
    if (inc.category === 'storage' || inc.reason === 'PVCPending' || STORAGE_TEXT.test(all)) return 'storage'
    if (inc.category === 'node' || ['NodeNotReady', 'DiskPressure', 'MemoryPressure', 'PIDPressure', 'NodeDiskFilling', 'NodeMemoryHigh', 'NodeCPUHigh'].includes(inc.reason)) return 'node'
    if (NETWORK_TEXT.test(all)) return 'network'
    return 'app'
}
