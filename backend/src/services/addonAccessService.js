import { automationEngine } from './automationEngine.js'

const KB = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'

// Best-effort command runner — never throws
async function run(ssh, cmd) {
    try {
        const r = await ssh.execCommand(cmd)
        return { ok: r.code === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
    } catch (e) {
        return { ok: false, out: '', err: e.message }
    }
}

// Get a service's NodePort for a given port name/index
async function getNodePort(ssh, ns, svc, portQuery = '{.spec.ports[0].nodePort}') {
    const r = await run(ssh, `${KB} get svc ${svc} -n ${ns} -o jsonpath='${portQuery}' 2>/dev/null`)
    return r.ok && r.out ? r.out : null
}

class AddonAccessService {

    /**
     * Discover all installed addons in a cluster with access URLs + credentials.
     * Runs live against the cluster via SSH (routes through Gateway Agent if configured).
     * Ensures each addon UI is exposed via NodePort so it's reachable on the internal network.
     */
    async getAccessInfo(cluster) {
        const master = cluster.masterNodes?.[0]
        if (!master) throw new Error('No master node found for this cluster')

        // NodePort is reachable on every node IP; use the master's IP for the URL
        const nodeIp = master.ip

        let ssh
        try {
            ssh = await automationEngine.connectSSH(master)
        } catch (err) {
            throw new Error(`Cannot connect to cluster master ${nodeIp}: ${err.message}`)
        }

        const addons = []

        try {
            // ── Nginx Ingress ────────────────────────────────────────────────
            const ingress = await run(ssh, `${KB} get deploy ingress-nginx-controller -n ingress-nginx --no-headers 2>/dev/null`)
            if (ingress.ok && ingress.out) {
                const httpPort  = await getNodePort(ssh, 'ingress-nginx', 'ingress-nginx-controller', "{.spec.ports[?(@.name=='http')].nodePort}")
                const httpsPort = await getNodePort(ssh, 'ingress-nginx', 'ingress-nginx-controller', "{.spec.ports[?(@.name=='https')].nodePort}")
                addons.push({
                    key: 'ingress',
                    name: 'Nginx Ingress',
                    icon: 'globe',
                    installed: true,
                    hasUI: false,
                    url: httpPort ? `http://${nodeIp}:${httpPort}` : null,
                    urlHttps: httpsPort ? `https://${nodeIp}:${httpsPort}` : null,
                    auth: null,
                    note: 'Traffic controller — route Ingress resources through these ports.'
                })
            }

            // ── Prometheus ───────────────────────────────────────────────────
            const prom = await run(ssh, `${KB} get svc prometheus-nodeport -n monitoring --no-headers 2>/dev/null`)
            if (prom.ok && prom.out) {
                const port = await getNodePort(ssh, 'monitoring', 'prometheus-nodeport') || '30090'
                addons.push({
                    key: 'prometheus',
                    name: 'Prometheus',
                    icon: 'activity',
                    installed: true,
                    hasUI: true,
                    url: `http://${nodeIp}:${port}`,
                    auth: null,
                    note: 'Metrics query UI. No authentication (secure via network/firewall).'
                })
            }

            // ── Grafana ──────────────────────────────────────────────────────
            const grafana = await run(ssh, `${KB} get deploy grafana -n monitoring --no-headers 2>/dev/null`)
            if (grafana.ok && grafana.out) {
                const port = await getNodePort(ssh, 'monitoring', 'grafana') || '30000'
                addons.push({
                    key: 'grafana',
                    name: 'Grafana',
                    icon: 'bar-chart',
                    installed: true,
                    hasUI: true,
                    url: `http://${nodeIp}:${port}`,
                    auth: { username: 'admin', password: 'admin' },
                    note: 'Change the default password on first login.'
                })
            }

            // ── Kubernetes Dashboard ─────────────────────────────────────────
            const dash = await run(ssh, `${KB} get deploy kubernetes-dashboard -n kubernetes-dashboard --no-headers 2>/dev/null`)
            if (dash.ok && dash.out) {
                // Ensure it's exposed via NodePort (default install is ClusterIP)
                let port = await getNodePort(ssh, 'kubernetes-dashboard', 'kubernetes-dashboard')
                if (!port) {
                    await run(ssh, `${KB} patch svc kubernetes-dashboard -n kubernetes-dashboard -p '{"spec":{"type":"NodePort","ports":[{"port":443,"targetPort":8443,"nodePort":30643}]}}' 2>/dev/null`)
                    port = '30643'
                }
                // Generate a short-lived admin token for login
                const tokenR = await run(ssh, `${KB} -n kubernetes-dashboard create token dashboard-admin --duration=24h 2>/dev/null`)
                addons.push({
                    key: 'dashboard',
                    name: 'Kubernetes Dashboard',
                    icon: 'layout-dashboard',
                    installed: true,
                    hasUI: true,
                    url: `https://${nodeIp}:${port}`,
                    auth: { username: 'Token', token: tokenR.out || 'Run: kubectl -n kubernetes-dashboard create token dashboard-admin' },
                    note: 'Select "Token" login method and paste the token. Token valid 24h.'
                })
            }

            // ── cert-manager ─────────────────────────────────────────────────
            const cm = await run(ssh, `${KB} get deploy cert-manager -n cert-manager --no-headers 2>/dev/null`)
            if (cm.ok && cm.out) {
                addons.push({
                    key: 'cert-manager',
                    name: 'cert-manager',
                    icon: 'shield',
                    installed: true,
                    hasUI: false,
                    url: null,
                    auth: null,
                    note: 'Runs in-cluster. Manage via Certificate/ClusterIssuer resources (selfsigned-issuer ready).'
                })
            }

            // ── Longhorn ─────────────────────────────────────────────────────
            const lh = await run(ssh, `${KB} get svc longhorn-frontend-nodeport -n longhorn-system --no-headers 2>/dev/null`)
            if (lh.ok && lh.out) {
                const port = await getNodePort(ssh, 'longhorn-system', 'longhorn-frontend-nodeport') || '30080'
                addons.push({
                    key: 'longhorn',
                    name: 'Longhorn Storage',
                    icon: 'database',
                    installed: true,
                    hasUI: true,
                    url: `http://${nodeIp}:${port}`,
                    auth: null,
                    note: 'Storage management UI. No authentication by default (secure via network).'
                })
            }

            // ── ArgoCD ───────────────────────────────────────────────────────
            const argo = await run(ssh, `${KB} get svc argocd-server -n argocd --no-headers 2>/dev/null`)
            if (argo.ok && argo.out) {
                const port = await getNodePort(ssh, 'argocd', 'argocd-server', "{.spec.ports[?(@.name=='https')].nodePort}") || '30443'
                const pwR = await run(ssh, `${KB} -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null`)
                addons.push({
                    key: 'argocd',
                    name: 'ArgoCD',
                    icon: 'git-branch',
                    installed: true,
                    hasUI: true,
                    url: `https://${nodeIp}:${port}`,
                    auth: { username: 'admin', password: pwR.out || 'Secret not found — may have been rotated' },
                    note: 'GitOps delivery UI. Change the admin password after first login.'
                })
            }

            return {
                clusterId: cluster.id,
                clusterName: cluster.clusterName,
                nodeIp,
                addons,
                fetchedAt: new Date().toISOString()
            }

        } finally {
            ssh.dispose?.()
        }
    }
}

export const addonAccessService = new AddonAccessService()
