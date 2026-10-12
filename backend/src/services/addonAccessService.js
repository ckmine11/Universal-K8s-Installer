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
                const lbIp = (await run(ssh, `${KB} -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null`)).out
                if (lbIp) {
                    addons.push({ key: 'ingress', name: 'Nginx Ingress', icon: 'globe', installed: true, hasUI: false, url: `http://${lbIp}`, urlHttps: `https://${lbIp}`, auth: null,
                        note: `Traffic controller on its own IP ${lbIp} (from MetalLB) — point your DNS names there.${httpPort ? ` Node ports ${httpPort}/${httpsPort} keep working too.` : ''}` })
                } else addons.push({
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
            let promSvc = 'kubeez-prometheus'
            let prom = await run(ssh, `${KB} get svc kubeez-prometheus -n monitoring --no-headers 2>/dev/null`)
            if (!(prom.ok && prom.out)) { promSvc = 'prometheus-nodeport'; prom = await run(ssh, `${KB} get svc prometheus-nodeport -n monitoring --no-headers 2>/dev/null`) }
            if (prom.ok && prom.out) {
                const port = await getNodePort(ssh, 'monitoring', promSvc) || '30090'
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
                const pw = (await run(ssh, `${KB} -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d 2>/dev/null`)).out
                addons.push({
                    key: 'grafana',
                    name: 'Grafana',
                    icon: 'bar-chart',
                    installed: true,
                    hasUI: true,
                    url: `http://${nodeIp}:${port}`,
                    auth: { username: 'admin', password: pw || 'admin' },
                    note: pw ? 'Dashboards for nodes, pods and Kubernetes are ready under Dashboards.' : 'Change the default password on first login (or apply the Prometheus + Grafana settings once to get a generated one).'
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
                let tokenR = await run(ssh, `${KB} -n kubernetes-dashboard create token dashboard-admin --duration=24h 2>/dev/null`)
                if (!tokenR.out) tokenR = await run(ssh, `${KB} -n kubernetes-dashboard create token dashboard-viewer --duration=24h 2>/dev/null`)
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

            // ── The add-ons below: one round-trip tells which of them run ────
            const PRESENT = { 'nfs-provisioner': 'nfs-provisioner deploy/nfs-provisioner', 'snapshot-controller': 'snapshot-controller deploy/snapshot-controller',
                elasticsearch: 'elastic-system sts/elastic-operator', fluentd: 'fluentd svc/fluentd', 'fluent-bit': 'fluent-bit ds/kubeez-fluent-bit',
                harbor: 'harbor deploy/harbor-core', flux: 'flux-system deploy/source-controller', jenkins: 'jenkins sts/jenkins', vault: 'vault sts/vault',
                gatekeeper: 'gatekeeper-system deploy/gatekeeper-controller-manager', falco: 'falco ds/falco', 'trivy-operator': 'trivy-system deploy/trivy-operator' }
            const pres = await run(ssh, Object.entries(PRESENT).map(([k, v]) => { const [ns, ref] = v.split(' '); return `${KB} -n ${ns} get ${ref} -o name >/dev/null 2>&1 && echo ${k}` }).join('; '))
            const has = new Set((pres.out || '').split('\n').map(s => s.trim()).filter(Boolean))
            const secret = async (ns, name, key) => (await run(ssh, `${KB} -n ${ns} get secret ${name} -o jsonpath='{.data.${key.replace(/\./g, '\\.')}}' 2>/dev/null | base64 -d 2>/dev/null`)).out || null

            // ── NFS storage ──────────────────────────────────────────────────
            if (has.has('nfs-provisioner')) {
                const env = await run(ssh, `${KB} -n nfs-provisioner get deploy nfs-provisioner -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\\n"}{end}' 2>/dev/null`)
                const v = Object.fromEntries((env.out || '').split('\n').map(l => l.split('=')))
                const pvs = await run(ssh, `${KB} get pv -o jsonpath='{range .items[?(@.spec.storageClassName=="nfs-client")]}{.metadata.name}{"\\n"}{end}' 2>/dev/null | grep -c .`)
                addons.push({
                    key: 'nfs-provisioner', name: 'NFS storage', icon: 'database', installed: true, hasUI: false, url: null, auth: null,
                    details: `Server: ${v.NFS_SERVER || '—'}:${v.NFS_PATH || ''}\nStorageClass: nfs-client\nVolumes: ${Number(pvs.out) || 0}`,
                    example: 'storageClassName: nfs-client\naccessModes: [ReadWriteMany]   # shared by many pods',
                    note: 'Each volume is a folder on the NFS server. ReadWriteMany volumes can be used by pods on different nodes at once.'
                })
            }

            // ── Volume snapshots ─────────────────────────────────────────────
            if (has.has('snapshot-controller')) {
                const cls = await run(ssh, `${KB} get volumesnapshotclass -o jsonpath='{range .items[*]}{.metadata.name} ({.driver}){"\\n"}{end}' 2>/dev/null`)
                const n = await run(ssh, `${KB} get volumesnapshots -A --no-headers 2>/dev/null | grep -c .`)
                addons.push({
                    key: 'snapshot-controller', name: 'Volume snapshots', icon: 'database', installed: true, hasUI: false, url: null, auth: null,
                    details: `Snapshot classes:\n${cls.out || '  none yet (install Longhorn, then apply the settings again)'}\nSnapshots: ${Number(n.out) || 0}`,
                    example: 'apiVersion: snapshot.storage.k8s.io/v1\nkind: VolumeSnapshot\nmetadata: { name: db-before-upgrade, namespace: shop }\nspec:\n  volumeSnapshotClassName: longhorn-snapshot\n  source: { persistentVolumeClaimName: db-data }',
                    note: 'A VolumeSnapshot keeps a point-in-time copy of a volume; restore it as a new PVC (dataSource).'
                })
            }

            // ── Elasticsearch + Kibana ───────────────────────────────────────
            if (has.has('elasticsearch')) {
                const st = await run(ssh, `${KB} -n elastic-system get elasticsearch kubeez -o jsonpath='{.status.health} {.status.version} {.status.availableNodes}' 2>/dev/null`)
                const [health, version, nodes] = (st.out || '').split(' ')
                const kPort = await getNodePort(ssh, 'elastic-system', 'kubeez-kb-http')
                const aPort = await getNodePort(ssh, 'elastic-system', 'kubeez-es-http')
                const pw = await secret('elastic-system', 'kubeez-es-elastic-user', 'elastic')
                addons.push({
                    key: 'elasticsearch', name: 'Elasticsearch + Kibana', icon: 'database', installed: true, hasUI: !!kPort,
                    url: kPort ? `http://${nodeIp}:${kPort}` : null,
                    auth: pw ? { username: 'elastic', password: pw } : null,
                    details: `Health: ${health || 'starting'}${version ? ` · version ${version}` : ''}${nodes ? ` · ${nodes} node(s)` : ''}\nInside the cluster: http://kubeez-es-http.elastic-system:9200${aPort && aPort !== '9200' ? `\nFrom your network: http://${nodeIp}:${aPort}` : ''}`,
                    example: `curl -u elastic:<password> http://${aPort && aPort !== '9200' ? `${nodeIp}:${aPort}` : 'kubeez-es-http.elastic-system:9200'}/_cat/indices?v`,
                    note: kPort ? 'Kibana: Discover → create a data view "kubeez-logs-*" to search the logs sent by Fluent Bit / Fluentd.' : 'Turn on Kibana in the settings for a web UI.'
                })
            }

            // ── Fluentd / Fluent Bit ─────────────────────────────────────────
            for (const [key, ns, name, cm] of [['fluentd', 'fluentd', 'Fluentd', 'fluentd-config'], ['fluent-bit', 'fluent-bit', 'Fluent Bit', 'kubeez-fluent-bit']]) {
                if (!has.has(key)) continue
                const conf = await run(ssh, `${KB} -n ${ns} get cm ${cm} -o yaml 2>/dev/null | grep -E '^ +(@type|Name|host|Host|port|Port) ' | tr -s ' '`)
                const target = /elasticsearch|Name es/.test(conf.out) ? `Elasticsearch (${(conf.out.match(/[Hh]ost (\S+)/) || [])[1] || '?'})` : /forward/.test(conf.out) ? 'Fluentd (forward)' : 'its own log (stdout)'
                addons.push({
                    key, name, icon: 'activity', installed: true, hasUI: false, url: null, auth: null,
                    details: `Logs go to: ${target}${key === 'fluentd' ? '\nReceives from Fluent Bit on: fluentd.fluentd.svc:24224' : ''}`,
                    example: `kubectl -n ${ns} logs -l app.kubernetes.io/name=${key} --tail=20`,
                    note: 'Change where logs go in the add-on\'s Settings.'
                })
            }

            // ── Harbor ───────────────────────────────────────────────────────
            if (has.has('harbor')) {
                const port = await getNodePort(ssh, 'harbor', 'harbor', "{.spec.ports[?(@.name=='https')].nodePort}") || '30003'
                const ext = await run(ssh, `${KB} -n harbor get cm harbor-core -o jsonpath='{.data.EXT_ENDPOINT}' 2>/dev/null`)
                const url = ext.out || `https://${nodeIp}:${port}`
                const host = url.replace(/^https?:\/\//, '')
                addons.push({
                    key: 'harbor', name: 'Harbor registry', icon: 'package', installed: true, hasUI: true, url,
                    auth: { username: 'admin', password: await secret('harbor', 'kubeez-harbor-admin', 'HARBOR_ADMIN_PASSWORD') || 'Secret not found' },
                    example: `kubectl -n harbor get secret kubeez-harbor-tls -o jsonpath='{.data.ca\\.crt}' | base64 -d > harbor-ca.crt\n# Linux Docker: sudo mkdir -p /etc/docker/certs.d/${host} && sudo cp harbor-ca.crt /etc/docker/certs.d/${host}/ca.crt\ndocker login ${host}\ndocker tag nginx:1.27 ${host}/library/nginx:1.27 && docker push ${host}/library/nginx:1.27`,
                    note: `Certificate by KubeEZ's own CA (also under Harbor → Registry certificate). Pods on this cluster can use images like ${host}/library/nginx:1.27 directly.`
                })
            }

            // ── Flux CD ──────────────────────────────────────────────────────
            if (has.has('flux')) {
                const ks = await run(ssh, `${KB} get kustomizations.kustomize.toolkit.fluxcd.io -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name} {.status.conditions[?(@.type=="Ready")].status} {.status.lastAppliedRevision}{"\\n"}{end}' 2>/dev/null`)
                addons.push({
                    key: 'flux', name: 'Flux CD', icon: 'git-branch', installed: true, hasUI: false, url: null, auth: null,
                    details: ks.out ? `Kustomizations:\n${ks.out.split('\n').map(l => { const [n, r, rev] = l.split(' '); return `  ${n} — ${r === 'True' ? 'in sync' : 'not ready'}${rev ? ` (${rev.slice(0, 40)})` : ''}` }).join('\n')}` : 'Nothing synced yet — set a repository in the settings, or add GitRepository / Kustomization objects.',
                    example: 'flux get all -A          # with the flux CLI\nkubectl get gitrepositories,kustomizations -A',
                    note: 'Flux applies what is in Git; change the cluster by committing to the repository.'
                })
            }

            // ── Jenkins ──────────────────────────────────────────────────────
            if (has.has('jenkins')) {
                const port = await getNodePort(ssh, 'jenkins', 'jenkins') || '30808'
                addons.push({
                    key: 'jenkins', name: 'Jenkins', icon: 'wrench', installed: true, hasUI: true, url: `http://${nodeIp}:${port}`,
                    auth: { username: (await secret('jenkins', 'jenkins', 'jenkins-admin-user')) || 'admin', password: await secret('jenkins', 'jenkins', 'jenkins-admin-password') || 'Secret not found' },
                    note: 'Builds run as pods in the jenkins namespace (Kubernetes agents). Change the admin password after the first login.'
                })
            }

            // ── Vault ────────────────────────────────────────────────────────
            if (has.has('vault')) {
                const port = await getNodePort(ssh, 'vault', 'vault-ui') || '30820'
                const st = await run(ssh, `${KB} -n vault exec vault-0 -c vault -- vault status -address=http://127.0.0.1:8200 2>/dev/null | grep -E '^(Sealed|Initialized|Version)'`)
                const [token, key] = await Promise.all([secret('vault', 'kubeez-vault-keys', 'root-token'), secret('vault', 'kubeez-vault-keys', 'unseal-key')])
                addons.push({
                    key: 'vault', name: 'HashiCorp Vault', icon: 'shield', installed: true, hasUI: true, url: `http://${nodeIp}:${port}/ui`,
                    auth: { username: 'Token', password: token || 'Not initialized by KubeEZ', usernameLabel: 'Sign-in method', passwordLabel: 'Root token', extra: key ? [{ label: 'Unseal key', value: key, secret: true }] : [] },
                    details: (st.out || 'Status unknown').replace(/ {2,}/g, ': '),
                    example: '# a pod gets secret/data/shop/db as a file — annotations on the pod:\nvault.hashicorp.com/agent-inject: "true"\nvault.hashicorp.com/role: "shop"\nvault.hashicorp.com/agent-inject-secret-db: "secret/data/shop/db"',
                    note: 'Kubernetes login (auth/kubernetes) and a key/value store (secret/) are ready — create a role for each app\'s service account.'
                })
            }

            // ── OPA Gatekeeper ───────────────────────────────────────────────
            if (has.has('gatekeeper')) {
                const c = await run(ssh, `${KB} get constraints -o jsonpath='{range .items[*]}{.metadata.name} {.spec.enforcementAction} {.status.totalViolations}{"\\n"}{end}' 2>/dev/null`)
                const rows = (c.out || '').split('\n').filter(Boolean).map(l => l.split(' '))
                const total = rows.reduce((n, r) => n + (Number(r[2]) || 0), 0)
                addons.push({
                    key: 'gatekeeper', name: 'OPA Gatekeeper', icon: 'shield', installed: true, hasUI: false, url: null, auth: null,
                    details: rows.length ? rows.map(([n, a, v]) => `${n.replace(/^kubeez-/, '')} — ${a === 'deny' ? 'blocks' : a === 'warn' ? 'warns' : 'reports'} · ${Number(v) || 0} violation(s)`).join('\n') : 'No constraints yet',
                    example: 'kubectl get constraints\nkubectl describe k8srequiredlabels <name>   # your own ConstraintTemplates work too',
                    note: total ? 'Some running pods break a rule — "kubectl describe" the constraint lists them. Fix them before switching to "Block".' : 'Pods are checked when created, and running ones every minute (audit).'
                })
            }

            // ── Falco ────────────────────────────────────────────────────────
            if (has.has('falco')) {
                const port = await getNodePort(ssh, 'falco', 'falco-falcosidekick-ui')
                const user = port ? await secret('falco', 'kubeez-falco-ui', 'FALCOSIDEKICK_UI_USER') : null
                const recent = await run(ssh, `${KB} -n falco logs ds/falco -c falco --since=1h 2>/dev/null | grep -c '"priority"'`)
                addons.push({
                    key: 'falco', name: 'Falco', icon: 'shield', installed: true, hasUI: !!port, url: port ? `http://${nodeIp}:${port}` : null,
                    auth: user ? { username: user.split(':')[0], password: user.split(':').slice(1).join(':') } : null,
                    details: `Alerts in the last hour (this node's Falco): ${Number(recent.out) || 0}`,
                    example: 'kubectl -n falco logs ds/falco -c falco --since=10m | grep -i warning',
                    note: 'Try it: open a shell in any container (kubectl exec -ti <pod> -- sh) — Falco reports "Terminal shell in container".'
                })
            }

            // ── Trivy Operator ───────────────────────────────────────────────
            if (has.has('trivy-operator')) {
                const vr = await run(ssh, `${KB} get vulnerabilityreports -A -o jsonpath='{range .items[*]}{.report.summary.criticalCount} {.report.summary.highCount}{"\\n"}{end}' 2>/dev/null`)
                let crit = 0, high = 0, n = 0
                for (const l of (vr.out || '').split('\n').filter(Boolean)) { const [c, h] = l.split(' ').map(Number); crit += c || 0; high += h || 0; n++ }
                const ca = await run(ssh, `${KB} get configauditreports -A -o jsonpath='{range .items[*]}{.report.summary.criticalCount} {.report.summary.highCount}{"\\n"}{end}' 2>/dev/null`)
                let cfg = 0
                for (const l of (ca.out || '').split('\n').filter(Boolean)) cfg += l.split(' ').map(Number).reduce((a, b) => a + (b || 0), 0)
                addons.push({
                    key: 'trivy-operator', name: 'Trivy Operator', icon: 'shield', installed: true, hasUI: false, url: null, auth: null,
                    details: n ? `Images scanned: ${n}\nVulnerabilities: ${crit} critical · ${high} high\nMisconfigurations (critical + high): ${cfg}` : 'First scans are running — results appear within minutes.',
                    example: 'kubectl get vulnerabilityreports -A -o wide\nkubectl get configauditreports -A -o wide',
                    note: 'Images are scanned again when they change and every 24 hours.'
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
