import net from 'net'

// Add-ons installed with Helm and configured from the UI.
//
// Each one describes:
//   fields     the simple settings shown as a form (with safe defaults)
//   versions   chart versions KubeEZ has checked, newest first (= recommended)
//   validate   form values (+ the cluster) → clean settings, or a 400 with the reason
//   releases   clean settings → Helm releases with their values
//   locked     values KubeEZ needs to find, check and repair the add-on — an
//              advanced YAML cannot change them
//   pre/post   shell run before / manifests + shell applied after Helm
//
// Everything that ends up in a shell line is built here from validated values
// only (numbers, IPs, fixed words) — never from free text.

const bad = (msg) => Object.assign(new Error(msg), { status: 400 })

const REPOS = {
    'metrics-server': { name: 'kubeez-metrics-server', url: 'https://kubernetes-sigs.github.io/metrics-server/' },
    metallb: { name: 'kubeez-metallb', url: 'https://metallb.github.io/metallb' },
    grafana: { name: 'kubeez-grafana', url: 'https://grafana.github.io/helm-charts' },
    fluent: { name: 'kubeez-fluent', url: 'https://fluent.github.io/helm-charts' },
    'sealed-secrets': { name: 'kubeez-sealed-secrets', url: 'https://bitnami.github.io/sealed-secrets' },
    kyverno: { name: 'kubeez-kyverno', url: 'https://kyverno.github.io/kyverno/' }
}

// Namespaces of the platform itself — policies and admission webhooks never touch them
export const SYSTEM_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'ingress-nginx', 'monitoring', 'kubernetes-dashboard',
    'cert-manager', 'longhorn-system', 'argocd', 'seaweedfs', 'velero', 'kubeez-explorer',
    'metrics-server', 'metallb-system', 'logging', 'sealed-secrets', 'kyverno']

// ── Small validated value types ─────────────────────────────────────────────
const int = (v, { min, max, label }) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label}: a whole number from ${min} to ${max}`)
    return n
}
const oneOf = (v, list, label) => {
    if (!list.includes(v)) throw bad(`${label}: choose ${list.join(', ')}`)
    return v
}
const bool = (v) => v === true || v === 'true'

const ipToInt = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
const intToIp = (n) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.')

/**
 * "192.168.1.240-192.168.1.250, 10.0.0.0/28" → [{ from, to, text }] (IPv4).
 * Rejects ranges that contain a node or the control-plane VIP.
 */
export function parseAddressPool(text, { taken = [] } = {}) {
    const parts = String(text || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    if (!parts.length) throw bad('IP addresses: enter at least one range, e.g. 192.168.1.240-192.168.1.250')
    if (parts.length > 10) throw bad('IP addresses: at most 10 ranges')
    const out = []
    for (const p of parts) {
        let from, to
        const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(p)
        const range = /^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$/.exec(p)
        if (cidr && net.isIPv4(cidr[1])) {
            const bits = Number(cidr[2])
            if (bits < 20 || bits > 32) throw bad(`IP addresses: "${p}" — use a prefix from /20 to /32`)
            const size = 2 ** (32 - bits)
            from = Math.floor(ipToInt(cidr[1]) / size) * size
            to = from + size - 1
        } else if (range && net.isIPv4(range[1]) && net.isIPv4(range[2])) {
            from = ipToInt(range[1]); to = ipToInt(range[2])
            if (to < from) throw bad(`IP addresses: "${p}" — the first address must come before the last`)
        } else if (net.isIPv4(p)) {
            from = to = ipToInt(p)
        } else {
            throw bad(`IP addresses: "${p}" is not an IPv4 address, range (a-b) or CIDR`)
        }
        if (to - from + 1 > 4096) throw bad(`IP addresses: "${p}" has more than 4096 addresses`)
        const special = [ipToInt('0.0.0.0'), ipToInt('255.255.255.255')]
        if (special.some(s => s >= from && s <= to) || from >= ipToInt('224.0.0.0') || to < ipToInt('1.0.0.0') || (from >= ipToInt('127.0.0.0') && from <= ipToInt('127.255.255.255'))) {
            throw bad(`IP addresses: "${p}" is not a usable address range`)
        }
        for (const t of taken) {
            if (!net.isIPv4(t.ip)) continue
            const n = ipToInt(t.ip)
            if (n >= from && n <= to) throw bad(`IP addresses: "${p}" contains ${t.ip} (${t.what}) — choose free addresses that no machine uses`)
        }
        for (const o of out) if (from <= o.to && to >= o.from) throw bad(`IP addresses: "${p}" overlaps "${o.text}"`)
        out.push({ from, to, text: p })
    }
    return out
}
const poolToMetallb = (pool) => pool.map(r => r.from === r.to ? `${intToIp(r.from)}/32` : `${intToIp(r.from)}-${intToIp(r.to)}`)
const poolSample = (pool, max = 32) => {
    const ips = []
    for (const r of pool) for (let n = r.from; n <= r.to && ips.length < max; n++) ips.push(intToIp(n))
    return ips
}

// ── Kyverno policies (ValidatingPolicy, CEL) ─────────────────────────────────
const containersOk = (cel) =>
    `object.spec.containers.all(c, ${cel}) && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, ${cel}))`
export const KYVERNO_POLICIES = {
    latestTag: {
        name: 'kubeez-disallow-latest-tag', label: 'No "latest" or missing image tags',
        expression: containersOk(`c.image.contains('@') || (c.image.matches(':[^/]+$') && !c.image.endsWith(':latest'))`),
        message: 'Use a fixed image tag (not "latest", not empty) so every node runs the same version.'
    },
    requestsLimits: {
        name: 'kubeez-require-requests-limits', label: 'CPU / memory requests and a memory limit',
        expression: `object.spec.containers.all(c, has(c.resources) && has(c.resources.requests) && 'cpu' in c.resources.requests && 'memory' in c.resources.requests && has(c.resources.limits) && 'memory' in c.resources.limits)`,
        message: 'Set resources.requests.cpu, resources.requests.memory and resources.limits.memory on every container.'
    },
    privileged: {
        name: 'kubeez-disallow-privileged', label: 'No privileged containers',
        expression: containersOk(`!has(c.securityContext) || !has(c.securityContext.privileged) || c.securityContext.privileged == false`),
        message: 'Privileged containers have full access to the node — not allowed.'
    },
    hostNamespaces: {
        name: 'kubeez-disallow-host-namespaces', label: 'No host network / PID / IPC',
        expression: `!(has(object.spec.hostNetwork) && object.spec.hostNetwork) && !(has(object.spec.hostPID) && object.spec.hostPID) && !(has(object.spec.hostIPC) && object.spec.hostIPC)`,
        message: 'Sharing the node\'s network, process or IPC namespace is not allowed.'
    }
}

function kyvernoPolicy(p, mode) {
    return {
        apiVersion: 'policies.kyverno.io/v1',
        kind: 'ValidatingPolicy',
        metadata: { name: p.name, labels: { 'app.kubernetes.io/managed-by': 'kubeez' }, annotations: { 'kubeez.io/title': p.label } },
        spec: {
            validationActions: [mode === 'Enforce' ? 'Deny' : 'Audit'],
            matchConstraints: {
                resourceRules: [{ apiGroups: [''], apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'], resources: ['pods'] }],
                namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'NotIn', values: SYSTEM_NAMESPACES }] }
            },
            validations: [{ expression: p.expression, message: p.message }]
        }
    }
}

// ── The add-ons ──────────────────────────────────────────────────────────────
export const HELM_ADDONS = {
    'metrics-server': {
        label: 'Metrics Server', ns: 'metrics-server', detect: 'deploy/metrics-server', tier: 'free',
        summary: 'CPU / memory per pod and node — makes "kubectl top" and autoscaling (HPA) work.',
        versions: [
            { id: '3.14.0', app: '0.9.0', charts: { 'metrics-server': '3.14.0' } },
            { id: '3.13.1', app: '0.8.1', charts: { 'metrics-server': '3.13.1' } }
        ],
        fields: [
            { key: 'secureTLS', type: 'bool', label: 'Verify kubelet certificates', default: false, help: 'Leave off on kubeadm clusters — kubelets there use self-signed certificates and metrics would fail.' },
            { key: 'replicas', type: 'number', label: 'Replicas', default: 1, min: 1, max: 3, help: '2 or more keeps "kubectl top" and autoscaling working during node maintenance.' }
        ],
        validate: (s) => ({ secureTLS: bool(s.secureTLS), replicas: int(s.replicas, { min: 1, max: 3, label: 'Replicas' }) }),
        releases: (s, ctx, v) => [{
            name: 'metrics-server', repo: REPOS['metrics-server'], chart: 'metrics-server', version: v.charts['metrics-server'],
            values: {
                fullnameOverride: 'metrics-server',
                replicas: s.replicas,
                args: s.secureTLS ? [] : ['--kubelet-insecure-tls'],
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } }
            }
        }],
        locked: { 'metrics-server': ['fullnameOverride'] },
        uninstallNote: '"kubectl top" and pod autoscaling stop working.'
    },

    metallb: {
        label: 'MetalLB', ns: 'metallb-system', detect: 'deploy/metallb-controller', tier: 'pro', needsSettings: true,
        summary: 'Real IP addresses for LoadBalancer Services on your own servers (otherwise they stay <pending>).',
        versions: [
            { id: '0.16.1', app: 'v0.16.1', charts: { metallb: '0.16.1' } },
            { id: '0.15.3', app: 'v0.15.3', charts: { metallb: '0.15.3' } }
        ],
        fields: [
            { key: 'addresses', type: 'text', label: 'Free IP addresses', default: '', placeholder: '192.168.1.240-192.168.1.250', help: 'Addresses in your servers\' network that no machine and no DHCP server uses. A range (a-b), a CIDR (/20–/32) or single IPs, comma separated.' },
            { key: 'mode', type: 'select', label: 'Mode', default: 'l2', options: [['l2', 'Layer 2 (ARP) — works on any network'], ['bgp', 'BGP — announce to your router']] },
            { key: 'myASN', type: 'number', label: 'Cluster ASN', default: 64500, min: 1, max: 4294967295, showIf: { mode: 'bgp' } },
            { key: 'peerAddress', type: 'text', label: 'Router IP', default: '', showIf: { mode: 'bgp' } },
            { key: 'peerASN', type: 'number', label: 'Router ASN', default: 64501, min: 1, max: 4294967295, showIf: { mode: 'bgp' } },
            { key: 'ingressLoadBalancer', type: 'bool', label: 'Give Nginx Ingress an IP from this range', default: true, help: 'Websites then answer on http://<that IP> instead of a node port.' }
        ],
        validate: (s, ctx) => {
            const taken = [...(ctx.nodeIps || []).map(ip => ({ ip, what: 'a node' })), ...(ctx.vip ? [{ ip: ctx.vip, what: 'the control-plane virtual IP' }] : [])]
            const pool = parseAddressPool(s.addresses, { taken })
            const mode = oneOf(s.mode || 'l2', ['l2', 'bgp'], 'Mode')
            const out = { addresses: pool.map(r => r.text).join(', '), mode, ingressLoadBalancer: s.ingressLoadBalancer === undefined ? true : bool(s.ingressLoadBalancer) }
            if (mode === 'bgp') {
                out.myASN = int(s.myASN, { min: 1, max: 4294967295, label: 'Cluster ASN' })
                out.peerASN = int(s.peerASN, { min: 1, max: 4294967295, label: 'Router ASN' })
                if (!net.isIPv4(String(s.peerAddress || ''))) throw bad('Router IP: enter the IPv4 address of your BGP router')
                out.peerAddress = String(s.peerAddress)
            }
            return out
        },
        releases: (s, ctx, v) => [{
            name: 'metallb', repo: REPOS.metallb, chart: 'metallb', version: v.charts.metallb,
            values: {
                // frr-k8s only for BGP; Layer 2 needs just controller + speaker
                frrk8s: { enabled: s.mode === 'bgp' },
                // a cluster without workers: the control-plane must announce too
                speaker: { ignoreExcludeLB: !(ctx.workerCount > 0), frr: { enabled: false } }
            }
        }],
        pre: (s) => {
            const pool = parseAddressPool(s.addresses)
            return [
                '# addresses already given to Services by MetalLB are expected to answer',
                `USED=" $(kubectl get svc -A -o jsonpath='{range .items[*]}{.status.loadBalancer.ingress[*].ip} {end}' 2>/dev/null) "`,
                'BUSY=""',
                '# ping when installed; and on the local network a machine that answers ARP',
                '# shows up in the neighbour table after any connection attempt (no ping needed)',
                `for ip in ${poolSample(pool).join(' ')}; do`,
                '    case "$USED" in *" $ip "*) continue ;; esac',
                '    if command -v ping >/dev/null 2>&1 && ping -c1 -W1 "$ip" >/dev/null 2>&1; then BUSY="$BUSY $ip"; continue; fi',
                '    timeout 1 bash -c "echo > /dev/tcp/$ip/9" >/dev/null 2>&1',
                '    ip neigh show "$ip" 2>/dev/null | grep -q lladdr && BUSY="$BUSY $ip"',
                'done',
                '[ -z "$BUSY" ] || fail IP_IN_USE "These addresses already answer on the network:$BUSY" "Choose a range that no machine uses (check your router\'s DHCP range), then apply again."'
            ].join('\n')
        },
        post: (s) => {
            const manifests = [
                { apiVersion: 'metallb.io/v1beta1', kind: 'IPAddressPool', metadata: { name: 'kubeez-pool', namespace: 'metallb-system' }, spec: { addresses: poolToMetallb(parseAddressPool(s.addresses)) } }
            ]
            if (s.mode === 'bgp') {
                manifests.push(
                    { apiVersion: 'metallb.io/v1beta2', kind: 'BGPPeer', metadata: { name: 'kubeez-router', namespace: 'metallb-system' }, spec: { myASN: s.myASN, peerASN: s.peerASN, peerAddress: s.peerAddress } },
                    { apiVersion: 'metallb.io/v1beta1', kind: 'BGPAdvertisement', metadata: { name: 'kubeez-bgp', namespace: 'metallb-system' }, spec: { ipAddressPools: ['kubeez-pool'] } })
            } else {
                manifests.push({ apiVersion: 'metallb.io/v1beta1', kind: 'L2Advertisement', metadata: { name: 'kubeez-l2', namespace: 'metallb-system' }, spec: { ipAddressPools: ['kubeez-pool'] } })
            }
            // the objects of the other mode go away when the mode changes
            const other = s.mode === 'bgp' ? [['l2advertisements.metallb.io', 'kubeez-l2']] : [['bgpadvertisements.metallb.io', 'kubeez-bgp'], ['bgppeers.metallb.io', 'kubeez-router']]
            const svcType = s.ingressLoadBalancer ? 'LoadBalancer' : 'NodePort'
            const script = [
                ...other.map(([kind, name]) => `kubectl -n metallb-system delete ${kind} ${name} --ignore-not-found >/dev/null 2>&1 || true`),
                'if kubectl -n ingress-nginx get svc ingress-nginx-controller >/dev/null 2>&1; then',
                `    kubectl -n ingress-nginx patch svc ingress-nginx-controller -p '{"spec":{"type":"${svcType}"}}' >/dev/null && log "Nginx Ingress Service: ${svcType}"`,
                ...(s.ingressLoadBalancer ? [
                    '    for _ in $(seq 1 12); do',
                    `        IP=$(kubectl -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)`,
                    '        [ -n "$IP" ] && { log "✓ Nginx Ingress answers on http://$IP"; break; }',
                    '        sleep 5',
                    '    done',
                    '    [ -n "$IP" ] || log "⚠ Nginx Ingress has no IP yet — check the address range"'
                ] : []),
                'fi'
            ].join('\n')
            return { manifests, script }
        },
        uninstallNote: 'LoadBalancer Services lose their IPs (they go back to <pending>). Nginx Ingress keeps working on its node ports.'
    },

    loki: {
        label: 'Loki logs', ns: 'logging', detect: 'sts/loki', tier: 'pro', keepsData: true,
        summary: 'Logs of every pod in one place, searchable in Grafana (Fluent Bit collects them on every node).',
        versions: [
            { id: '7.3.0', app: '3.6.12', charts: { loki: '7.3.0', 'fluent-bit': '0.58.3' } },
            { id: '7.2.0', app: '3.6.11', charts: { loki: '7.2.0', 'fluent-bit': '0.58.2' } }
        ],
        fields: [
            { key: 'retentionDays', type: 'number', label: 'Keep logs for', unit: 'days', default: 7, min: 1, max: 90 },
            { key: 'sizeGi', type: 'number', label: 'Disk for logs', unit: 'GiB', default: 10, min: 1, max: 500 },
            { key: 'storage', type: 'select', label: 'Where logs are stored', default: 'auto', options: [['auto', 'Longhorn if installed, else the node'], ['longhorn', 'Longhorn volume (kept if the pod moves)'], ['default', 'The cluster\'s default StorageClass'], ['node', 'Node disk only (lost if the pod moves to another node)']] }
        ],
        validate: (s, ctx) => {
            let storage = oneOf(s.storage || 'auto', ['auto', 'longhorn', 'default', 'node'], 'Storage')
            if (storage === 'auto') storage = ctx.addons?.longhorn ? 'longhorn' : 'node'
            if (storage === 'longhorn' && !ctx.addons?.longhorn) throw bad('Storage: Longhorn is not installed on this cluster — install it first or choose another option')
            return { retentionDays: int(s.retentionDays, { min: 1, max: 90, label: 'Keep logs for (days)' }), sizeGi: int(s.sizeGi, { min: 1, max: 500, label: 'Disk for logs (GiB)' }), storage }
        },
        releases: (s, ctx, v) => {
            const persist = s.storage !== 'node'
            return [{
                name: 'loki', repo: REPOS.grafana, chart: 'loki', version: v.charts.loki,
                values: {
                    fullnameOverride: 'loki',
                    deploymentMode: 'SingleBinary',
                    loki: {
                        auth_enabled: false,
                        commonConfig: { replication_factor: 1 },
                        storage: { type: 'filesystem' },
                        schemaConfig: { configs: [{ from: '2024-04-01', store: 'tsdb', object_store: 'filesystem', schema: 'v13', index: { prefix: 'loki_index_', period: '24h' } }] },
                        limits_config: { retention_period: `${s.retentionDays * 24}h` },
                        compactor: { retention_enabled: true, delete_request_store: 'filesystem' }
                    },
                    singleBinary: {
                        replicas: 1,
                        persistence: { enabled: persist, size: `${s.sizeGi}Gi`, storageClass: s.storage === 'longhorn' ? 'longhorn' : null },
                        ...(persist ? {} : {
                            extraVolumes: [{ name: 'storage', emptyDir: { sizeLimit: `${s.sizeGi}Gi` } }],
                            extraVolumeMounts: [{ name: 'storage', mountPath: '/var/loki' }]
                        }),
                        resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '1Gi' } }
                    },
                    read: { replicas: 0 }, write: { replicas: 0 }, backend: { replicas: 0 },
                    gateway: { enabled: false },
                    chunksCache: { enabled: false }, resultsCache: { enabled: false },
                    lokiCanary: { enabled: false }, test: { enabled: false }
                }
            }, {
                name: 'fluent-bit', repo: REPOS.fluent, chart: 'fluent-bit', version: v.charts['fluent-bit'],
                values: {
                    fullnameOverride: 'fluent-bit',
                    tolerations: [{ operator: 'Exists' }],   // every node, control-planes too
                    resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
                    config: {
                        inputs: [
                            '[INPUT]',
                            '    Name tail',
                            '    Path /var/log/containers/*.log',
                            '    Exclude_Path /var/log/containers/fluent-bit-*.log',
                            '    multiline.parser docker, cri',
                            '    Tag kube.*',
                            '    DB /var/log/kubeez-fluent-bit.db',
                            '    Mem_Buf_Limit 5MB',
                            '    Skip_Long_Lines On',
                            ''
                        ].join('\n'),
                        filters: [
                            '[FILTER]',
                            '    Name kubernetes',
                            '    Match kube.*',
                            '    Merge_Log On',
                            '    Keep_Log Off',
                            '    K8S-Logging.Parser On',
                            '    K8S-Logging.Exclude On',
                            ''
                        ].join('\n'),
                        outputs: [
                            '[OUTPUT]',
                            '    Name loki',
                            '    Match kube.*',
                            '    Host loki.logging.svc',
                            '    Port 3100',
                            '    Labels job=fluent-bit',
                            "    Label_keys $kubernetes['namespace_name'],$kubernetes['pod_name'],$kubernetes['container_name'],$kubernetes['host']",
                            '    Remove_keys kubernetes,stream,_p',
                            '    Line_Format json',
                            '    Retry_Limit 5',
                            ''
                        ].join('\n')
                    }
                }
            }]
        },
        // Grafana of the Monitoring add-on gets Loki as a data source
        post: () => ({ manifests: [], script: GRAFANA_LOKI_SCRIPT }),
        locked: { loki: ['fullnameOverride', 'deploymentMode'], 'fluent-bit': ['fullnameOverride'] },
        uninstallNote: 'All collected logs are deleted. The logs of running pods are still on the nodes (kubectl logs).'
    },

    'sealed-secrets': {
        label: 'Sealed Secrets', ns: 'sealed-secrets', detect: 'deploy/sealed-secrets-controller', tier: 'pro',
        summary: 'Encrypt Secrets so they can be stored in Git — only this cluster can decrypt them. Pairs with ArgoCD.',
        versions: [
            { id: '2.20.0', app: '0.40.0', charts: { 'sealed-secrets': '2.20.0' } },
            { id: '2.19.3', app: '0.39.1', charts: { 'sealed-secrets': '2.19.3' } }
        ],
        fields: [
            { key: 'keyRenewDays', type: 'number', label: 'New encryption key every', unit: 'days', default: 30, min: 0, max: 365, help: '0 = never. Old keys are kept, so older sealed secrets still open. The keys are inside the etcd backups.' }
        ],
        validate: (s) => ({ keyRenewDays: int(s.keyRenewDays, { min: 0, max: 365, label: 'Key renewal (days)' }) }),
        releases: (s, ctx, v) => [{
            name: 'sealed-secrets', repo: REPOS['sealed-secrets'], chart: 'sealed-secrets', version: v.charts['sealed-secrets'],
            values: {
                fullnameOverride: 'sealed-secrets-controller',
                keyrenewperiod: s.keyRenewDays ? `${s.keyRenewDays * 24}h` : '0',
                resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } }
            }
        }],
        // kubeseal on the control-plane: "Seal a secret" in KubeEZ uses it
        post: (s, ctx, v) => ({ manifests: [], script: kubesealScript(v.app) }),
        locked: { 'sealed-secrets': ['fullnameOverride'] },
        uninstallNote: 'The controller and its keys are deleted — SealedSecrets in Git can no longer be opened by this cluster (Secrets already created stay). Keep an etcd backup if you may need the keys.'
    },

    kyverno: {
        label: 'Kyverno policies', ns: 'kyverno', detect: 'deploy/kyverno-admission-controller', tier: 'pro',
        summary: 'Rules for what may run: no "latest" images, limits required, no privileged pods — report or block.',
        versions: [
            { id: '3.9.1', app: 'v1.19.1', charts: { kyverno: '3.9.1' } },
            { id: '3.8.2', app: 'v1.18.2', charts: { kyverno: '3.8.2' } }
        ],
        fields: [
            { key: 'mode', type: 'select', label: 'When a rule is broken', default: 'Audit', options: [['Audit', 'Report only (recommended to start)'], ['Enforce', 'Block the pod']] },
            ...Object.entries(KYVERNO_POLICIES).map(([k, p]) => ({ key: `policy_${k}`, type: 'bool', label: p.label, default: true, group: 'Rules' })),
            { key: 'replicas', type: 'select', label: 'Admission controller', default: '1', options: [['1', '1 replica'], ['3', '3 replicas (high availability)']] }
        ],
        validate: (s) => {
            const out = { mode: oneOf(s.mode || 'Audit', ['Audit', 'Enforce'], 'Mode'), replicas: Number(oneOf(String(s.replicas ?? '1'), ['1', '3'], 'Replicas')) }
            for (const k of Object.keys(KYVERNO_POLICIES)) out[`policy_${k}`] = s[`policy_${k}`] === undefined ? true : bool(s[`policy_${k}`])
            return out
        },
        releases: (s, ctx, v) => [{
            name: 'kyverno', repo: REPOS.kyverno, chart: 'kyverno', version: v.charts.kyverno,
            values: {
                // if Kyverno is down, requests are let through instead of blocking the cluster
                features: { forceFailurePolicyIgnore: { enabled: true } },
                config: { webhooks: { namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'NotIn', values: SYSTEM_NAMESPACES }] } } },
                admissionController: { replicas: s.replicas },
                backgroundController: { replicas: 1 }, cleanupController: { replicas: 1 }, reportsController: { replicas: 1 }
            }
        }],
        post: (s) => {
            const on = Object.entries(KYVERNO_POLICIES).filter(([k]) => s[`policy_${k}`])
            const off = Object.entries(KYVERNO_POLICIES).filter(([k]) => !s[`policy_${k}`]).map(([, p]) => p.name)
            return {
                manifests: on.map(([, p]) => kyvernoPolicy(p, s.mode)),
                script: off.length ? `kubectl delete validatingpolicies.policies.kyverno.io ${off.join(' ')} --ignore-not-found >/dev/null 2>&1 || true` : ''
            }
        },
        locked: { kyverno: ['features.forceFailurePolicyIgnore.enabled'] },
        uninstallNote: 'All KubeEZ policies and their reports are removed; nothing is blocked any more.'
    }
}

// The Monitoring add-on's Grafana data sources (install-addons.sh writes the
// same list when Loki is already there)
export const GRAFANA_DATASOURCES_WITH_LOKI = [
    'apiVersion: 1',
    'datasources:',
    '- name: Prometheus',
    '  type: prometheus',
    '  access: proxy',
    '  url: http://prometheus-operated.monitoring.svc:9090',
    '  isDefault: true',
    '- name: Loki',
    '  type: loki',
    '  access: proxy',
    '  url: http://loki.logging.svc:3100'
].join('\n')
const GRAFANA_LOKI_SCRIPT = [
    'if kubectl -n monitoring get cm grafana-config >/dev/null 2>&1; then',
    '    if kubectl -n monitoring get cm grafana-config -o jsonpath="{.data.datasource\\.yaml}" | grep -q "name: Loki"; then',
    '        log "✓ Grafana already has the Loki data source"',
    `    elif kubectl -n monitoring patch cm grafana-config --type merge -p '${JSON.stringify({ data: { 'datasource.yaml': GRAFANA_DATASOURCES_WITH_LOKI } })}' >/dev/null && kubectl -n monitoring rollout restart deploy/grafana >/dev/null 2>&1; then`,
    '        log "✓ Loki added to Grafana — open Grafana → Explore → Loki"',
    '    else',
    '        log "⚠ Could not add Loki to Grafana — add the data source by hand: http://loki.logging.svc:3100"',
    '    fi',
    'else',
    '    log "Tip: install Prometheus + Grafana to search these logs in Grafana — Loki is added there automatically"',
    'fi'
].join('\n')

function kubesealScript(app) {
    if (!/^\d+\.\d+\.\d+$/.test(app)) throw new Error('bad kubeseal version')
    return [
        `if ! kubeseal --version 2>/dev/null | grep -q "${app}"; then`,
        '    A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64',
        '    T=$(mktemp -d)',
        `    if curl -fsSL --retry 3 -m 300 "https://github.com/bitnami/sealed-secrets/releases/download/v${app}/kubeseal-${app}-linux-$A.tar.gz" -o "$T/k.tgz" && tar xzf "$T/k.tgz" -C "$T" kubeseal && install -m0755 "$T/kubeseal" /usr/local/bin/kubeseal; then`,
        `        log "✓ kubeseal ${app} installed on this control-plane"`,
        '    else',
        '        log "⚠ Could not download kubeseal — \\"Seal a secret\\" in KubeEZ needs it (github.com must be reachable). Repair to try again."',
        '    fi',
        '    rm -rf "$T"',
        'fi'
    ].join('\n')
}

export const HELM_ADDON_KEYS = Object.keys(HELM_ADDONS)
export const isHelmAddon = (key) => Object.prototype.hasOwnProperty.call(HELM_ADDONS, key)

/** Defaults of the form fields */
export function defaultSettings(key) {
    return Object.fromEntries(HELM_ADDONS[key].fields.map(f => [f.key, f.default]))
}

/** What the UI needs to draw the form */
export function addonSchema(key) {
    const a = HELM_ADDONS[key]
    return {
        key, label: a.label, summary: a.summary, namespace: a.ns, tier: a.tier, keepsData: !!a.keepsData, needsSettings: !!a.needsSettings,
        fields: a.fields, defaults: defaultSettings(key),
        versions: a.versions.map((v, i) => ({ id: v.id, app: v.app, recommended: i === 0 })),
        releases: a.releases(a.validate({ ...defaultSettings(key), ...(key === 'metallb' ? { addresses: '192.0.2.10-192.0.2.20' } : {}) }, { addons: { longhorn: true } }), {}, a.versions[0]).map(r => r.name),
        uninstallNote: a.uninstallNote
    }
}
