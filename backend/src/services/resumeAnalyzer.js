import { automationEngine } from './automationEngine.js'

const KB = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf'

// Run a command and return { ok, out, err }
async function run(ssh, cmd) {
    const r = await ssh.execCommand(cmd)
    return { ok: r.code === 0, out: r.stdout?.trim() || '', err: r.stderr?.trim() || '' }
}

class ResumeAnalyzer {

    async analyze(cluster, onLog) {
        const masterNode = cluster.masterNodes?.[0]
        if (!masterNode) throw new Error('No master node in cluster config')

        onLog?.('info', `Connecting to master node ${masterNode.ip} for cluster state analysis...`)

        let ssh
        try {
            ssh = await automationEngine.connectSSH(masterNode)
        } catch (err) {
            throw new Error(`Cannot connect to master node ${masterNode.ip}: ${err.message}`)
        }

        const checks = []

        try {
            // ── 1. Container runtime ─────────────────────────────────────────
            const containerd = await run(ssh, 'systemctl is-active containerd 2>/dev/null')
            const containerdVersion = containerd.ok
                ? (await run(ssh, 'containerd --version 2>/dev/null')).out?.split(' ')[2] || 'installed'
                : null
            checks.push({
                key: 'installContainerRuntime',
                label: 'Container Runtime (containerd)',
                done: containerd.ok,
                detail: containerd.ok
                    ? `Active — ${containerdVersion}`
                    : 'Not installed or not running'
            })

            // ── 2. Kubernetes components ─────────────────────────────────────
            const kubeadm = await run(ssh, 'kubeadm version -o short 2>/dev/null')
            const kubelet = await run(ssh, 'kubelet --version 2>/dev/null')
            const k8sOk = kubeadm.ok && kubelet.ok
            checks.push({
                key: 'installKubernetesComponents',
                label: 'Kubernetes Components (kubeadm + kubelet)',
                done: k8sOk,
                detail: k8sOk
                    ? `kubeadm ${kubeadm.out} / kubelet ${kubelet.out}`
                    : `Missing: ${!kubeadm.ok ? 'kubeadm ' : ''}${!kubelet.ok ? 'kubelet' : ''}`
            })

            // ── 3. Control plane ─────────────────────────────────────────────
            const adminConf = await run(ssh, 'sudo ls /etc/kubernetes/admin.conf 2>/dev/null')
            const etcdRunning = await run(ssh,
                'sudo ETCDCTL_API=3 etcdctl endpoint health --endpoints=https://127.0.0.1:2379 ' +
                '--cacert=/etc/kubernetes/pki/etcd/ca.crt ' +
                '--cert=/etc/kubernetes/pki/etcd/server.crt ' +
                '--key=/etc/kubernetes/pki/etcd/server.key 2>/dev/null | grep -c "is healthy"')
            const cpOk = adminConf.ok
            checks.push({
                key: 'initializeControlPlane',
                label: 'Control Plane (kubeadm init)',
                done: cpOk,
                detail: cpOk
                    ? `admin.conf found — etcd ${parseInt(etcdRunning.out) > 0 ? 'healthy' : 'check manually'}`
                    : 'admin.conf not found — control plane not initialized'
            })

            // ── 4. Network plugin (only if CP ready) ─────────────────────────
            let networkOk = false
            if (cpOk) {
                const netPods = await run(ssh,
                    `${KB} kubectl get pods -n kube-system --no-headers 2>/dev/null ` +
                    `| grep -E "calico|flannel|weave|cilium|canal|antrea" | grep -c "Running"`)
                networkOk = parseInt(netPods.out) >= 1
                const netName = await run(ssh,
                    `${KB} kubectl get pods -n kube-system --no-headers 2>/dev/null ` +
                    `| grep -E "calico|flannel|weave|cilium|canal|antrea" | awk '{print $1}' | head -1`)
                checks.push({
                    key: 'installNetworkPlugin',
                    label: 'Network Plugin (CNI)',
                    done: networkOk,
                    detail: networkOk
                        ? `Running — ${netName.out || 'CNI pods active'}`
                        : 'CNI pods not found or not Running'
                })
            } else {
                checks.push({ key: 'installNetworkPlugin', label: 'Network Plugin (CNI)', done: false, detail: 'Skipped — control plane not ready', skipped: true })
            }

            // ── 5. Node join status ──────────────────────────────────────────
            let joinedWorkerNames = []
            let missingWorkers = []
            let nodesJoinedOk = false

            if (cpOk) {
                const nodesOut = await run(ssh,
                    `${KB} kubectl get nodes --no-headers 2>/dev/null`)
                const nodeLines = nodesOut.out.split('\n').filter(Boolean)

                // Get all joined node names (hostname as k8s knows them)
                joinedWorkerNames = nodeLines
                    .filter(l => !l.includes('control-plane') && !l.includes('master'))
                    .map(l => l.split(/\s+/)[0])

                const expectedWorkers = cluster.workerNodes || []

                // Find workers not yet joined by comparing k8s names vs configured hostnames/IPs
                missingWorkers = expectedWorkers.filter(w => {
                    const hn = (w.hostname || '').toLowerCase()
                    const ip = (w.ip || '').toLowerCase()
                    return !joinedWorkerNames.some(jn =>
                        jn.toLowerCase().includes(hn) || jn.toLowerCase().includes(ip) ||
                        hn.includes(jn.toLowerCase())
                    )
                })

                nodesJoinedOk = expectedWorkers.length === 0 || missingWorkers.length === 0
                checks.push({
                    key: 'joinNodes',
                    label: 'Worker Nodes Join',
                    done: nodesJoinedOk,
                    detail: expectedWorkers.length === 0
                        ? 'No worker nodes configured'
                        : `${joinedWorkerNames.length}/${expectedWorkers.length} workers joined` +
                          (missingWorkers.length > 0
                              ? ` — Missing: ${missingWorkers.map(w => w.ip).join(', ')}`
                              : '')
                })
            } else {
                checks.push({ key: 'joinNodes', label: 'Worker Nodes Join', done: false, detail: 'Skipped', skipped: true })
            }

            // ── 6. Addons ────────────────────────────────────────────────────
            const addonChecks = {}
            if (cpOk) {
                const addonNsMap = {
                    ingress:    { ns: 'ingress-nginx',          label: 'Nginx Ingress' },
                    monitoring: { ns: 'monitoring',             label: 'Prometheus Stack' },
                    logging:    { ns: 'efk-logging',            label: 'EFK Logging' },
                    dashboard:  { ns: 'kubernetes-dashboard',   label: 'K8s Dashboard' },
                    certManager: { ns: 'cert-manager',          label: 'Cert-Manager' },
                    longhorn:   { ns: 'longhorn-system',        label: 'Longhorn Storage' },
                    argocd:     { ns: 'argocd',                 label: 'ArgoCD' }
                }

                for (const [key, { ns, label }] of Object.entries(addonNsMap)) {
                    if (!cluster.addons?.[key] && !cluster.addons?.[key.replace(/([A-Z])/g, '-$1').toLowerCase()]) continue
                    const r = await run(ssh,
                        `${KB} kubectl get pods -n ${ns} --no-headers 2>/dev/null | grep -c "Running"`)
                    addonChecks[key] = { done: parseInt(r.out) >= 1, label }
                }
            }

            const addonsDone = Object.keys(addonChecks).length === 0 ||
                Object.values(addonChecks).every(a => a.done)
            const addonDetail = Object.keys(addonChecks).length === 0
                ? 'No addons configured'
                : Object.entries(addonChecks)
                    .map(([, v]) => `${v.done ? '✓' : '✗'} ${v.label}`)
                    .join(', ')

            checks.push({
                key: 'installAddons',
                label: 'Add-ons',
                done: addonsDone,
                detail: addonDetail,
                skipped: !cpOk
            })

            // ── Determine resume point ───────────────────────────────────────
            let resumeFromStep = null
            for (const c of checks) {
                if (!c.done && !c.skipped) {
                    resumeFromStep = c.key
                    break
                }
            }

            const allDone = !resumeFromStep
            if (allDone) resumeFromStep = 'postValidation'

            onLog?.('success', `Analysis complete — resume from: ${resumeFromStep}`)

            return {
                checks,
                resumeFromStep,
                missingWorkers,
                allDone,
                summary: allDone
                    ? 'All steps completed — only post-validation needed'
                    : `Resume from: ${checks.find(c => c.key === resumeFromStep)?.label}`
            }

        } finally {
            ssh.dispose?.()
        }
    }
}

export const resumeAnalyzer = new ResumeAnalyzer()
