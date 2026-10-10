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

            // ── S3 Object Storage (SeaweedFS) ────────────────────────────────
            const sw = await run(ssh, `${KB} get deploy seaweedfs -n seaweedfs --no-headers 2>/dev/null`)
            if (sw.ok && sw.out) {
                const port = await getNodePort(ssh, 'seaweedfs', 'seaweedfs-s3') || '30833'
                const key = (k) => run(ssh, `${KB} -n seaweedfs get secret seaweedfs-s3 -o jsonpath='{.data.${k}}' 2>/dev/null | base64 -d 2>/dev/null`)
                const [ak, sk, au, ap] = await Promise.all([key('accessKey'), key('secretKey'), key('adminUser'), key('adminPassword')])
                const uiPort = await getNodePort(ssh, 'seaweedfs', 'seaweedfs-admin')
                addons.push({
                    key: 'seaweedfs',
                    name: 'S3 Object Storage (SeaweedFS)',
                    icon: 'database',
                    installed: true,
                    hasUI: !!uiPort,
                    // Web admin UI (file browser, buckets) — installs before it existed get
                    // it with "Repair" in Manage Add-ons.
                    uiUrl: uiPort ? `http://${nodeIp}:${uiPort}` : null,
                    // An S3 API, not a website: a browser sends no signature and
                    // gets "AccessDenied" — the UI shows it as an endpoint, not a link.
                    apiEndpoint: true,
                    url: `http://${nodeIp}:${port}`,
                    example: `AWS_ACCESS_KEY_ID='<access key>' AWS_SECRET_ACCESS_KEY='<secret key>' aws --endpoint-url http://${nodeIp}:${port} --region us-east-1 s3 ls s3://backups/`,
                    auth: {
                        username: ak.out || null, password: sk.out || null, usernameLabel: 'Access key', passwordLabel: 'Secret key',
                        // Kept inside `auth` so the viewer-role redaction hides these too
                        extra: uiPort && ap.out ? [
                            { label: 'Web UI user', value: au.out || 'admin' },
                            { label: 'Web UI password', value: ap.out, secret: true }
                        ] : []
                    },
                    note: 'S3 API endpoint (region us-east-1, path-style) with a ready "backups" bucket. Use it from apps or as the offsite backup target of OTHER clusters — not of this cluster itself.'
                })
            }

            // ── Metrics Server ───────────────────────────────────────────────
            const ms = await run(ssh, `${KB} -n metrics-server get deploy metrics-server --no-headers 2>/dev/null`)
            if (ms.ok && ms.out) {
                const top = await run(ssh, `${KB} top nodes 2>&1 | head -12`)
                addons.push({
                    key: 'metrics-server', name: 'Metrics Server', icon: 'activity', installed: true, hasUI: false, url: null, auth: null,
                    details: top.ok ? top.out : null,
                    example: 'kubectl top pods -A --sort-by=memory',
                    note: top.ok ? 'Live usage per node (kubectl top nodes). Autoscaling (HPA) can use CPU and memory now.' : 'Starting — "kubectl top" answers about a minute after the install.'
                })
            }

            // ── MetalLB ──────────────────────────────────────────────────────
            const lb = await run(ssh, `${KB} -n metallb-system get deploy metallb-controller --no-headers 2>/dev/null`)
            if (lb.ok && lb.out) {
                const pool = await run(ssh, `${KB} -n metallb-system get ipaddresspools.metallb.io kubeez-pool -o jsonpath='{.spec.addresses}' 2>/dev/null`)
                const svcs = await run(ssh, `${KB} get svc -A -o jsonpath='{range .items[?(@.spec.type=="LoadBalancer")]}{.metadata.namespace}/{.metadata.name} {.status.loadBalancer.ingress[0].ip}{"\\n"}{end}' 2>/dev/null`)
                addons.push({
                    key: 'metallb', name: 'MetalLB', icon: 'globe', installed: true, hasUI: false, url: null, auth: null,
                    details: `Address range: ${(pool.out || '—').replace(/[[\]"]/g, '')}\n${svcs.out ? `LoadBalancer Services:\n${svcs.out.split('\n').map(l => { const [n, ip] = l.split(' '); return `  ${n} → ${ip || '<pending>'}` }).join('\n')}` : 'No LoadBalancer Services yet.'}`,
                    example: 'kubectl expose deploy web --type=LoadBalancer --port=80',
                    note: 'Every Service of type LoadBalancer gets an IP from the range — reachable from your network.'
                })
            }

            // ── Loki (logs) ──────────────────────────────────────────────────
            const loki = await run(ssh, `${KB} -n logging get sts loki --no-headers 2>/dev/null`)
            if (loki.ok && loki.out) {
                const gPort = await getNodePort(ssh, 'monitoring', 'grafana')
                addons.push({
                    key: 'loki', name: 'Loki logs', icon: 'activity', installed: true, hasUI: !!gPort,
                    url: gPort ? `http://${nodeIp}:${gPort}/explore` : null, auth: null,
                    example: '{kubernetes_namespace_name="shop"} |= "error"',
                    note: gPort ? 'Open Grafana → Explore → choose "Loki", then filter by kubernetes_namespace_name, kubernetes_pod_name or kubernetes_container_name.'
                        : 'Install Prometheus + Grafana to search these logs — Loki is added to Grafana automatically. Inside the cluster: http://loki.logging.svc:3100'
                })
            }

            // ── Sealed Secrets ───────────────────────────────────────────────
            const ss = await run(ssh, `${KB} -n sealed-secrets get deploy sealed-secrets-controller --no-headers 2>/dev/null`)
            if (ss.ok && ss.out) {
                addons.push({
                    key: 'sealed-secrets', name: 'Sealed Secrets', icon: 'shield', installed: true, hasUI: false, url: null, auth: null,
                    example: 'kubeseal --controller-namespace sealed-secrets --controller-name sealed-secrets-controller --fetch-cert > cluster-cert.pem\nkubectl create secret generic db --from-literal=password=… --dry-run=client -o yaml | kubeseal --cert cluster-cert.pem -o yaml > db-sealed.yaml',
                    note: 'Use "Seal a secret" in Manage Add-ons, or kubeseal on your laptop with the public certificate. Commit the sealed YAML to Git; only this cluster can open it.'
                })
            }

            // ── Kyverno ──────────────────────────────────────────────────────
            const ky = await run(ssh, `${KB} -n kyverno get deploy kyverno-admission-controller --no-headers 2>/dev/null`)
            if (ky.ok && ky.out) {
                const rep = await run(ssh, `${KB} get policyreports.wgpolicyk8s.io -A -o jsonpath='{range .items[*]}{.summary.pass} {.summary.fail}{"\\n"}{end}' 2>/dev/null`)
                let pass = 0, fail = 0
                for (const l of (rep.out || '').split('\n')) { const [p, f] = l.trim().split(/\s+/).map(Number); pass += p || 0; fail += f || 0 }
                const pol = await run(ssh, `${KB} get validatingpolicies.policies.kyverno.io -l app.kubernetes.io/managed-by=kubeez -o jsonpath='{range .items[*]}{.metadata.name} {.spec.validationActions[0]}{"\\n"}{end}' 2>/dev/null`)
                addons.push({
                    key: 'kyverno', name: 'Kyverno policies', icon: 'shield', installed: true, hasUI: false, url: null, auth: null,
                    details: `${pol.out ? pol.out.split('\n').map(l => { const [n, a] = l.split(' '); return `${n.replace(/^kubeez-/, '')} — ${a === 'Deny' ? 'blocks' : 'reports'}` }).join('\n') : 'No KubeEZ rules active'}\n\nChecked resources: ${pass} pass · ${fail} break a rule`,
                    example: 'kubectl get policyreports -A',
                    note: fail ? 'Some workloads break a rule — the policy reports list which and why. Fix them before switching to "Block".' : 'Rules are checked when pods are created and in the background.'
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
