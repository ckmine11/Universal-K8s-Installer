// Text → YAML that is right the first time:
//   1. understand  the request → a small "intent" (app, kind, replicas, port,
//                  volume, schedule, exposure…): by rules (instant, no AI) or by
//                  the model (short JSON — easy even for a small CPU model)
//   2. build       KubeEZ writes the manifests itself from the intent and the app
//                  catalog (pinned image, port, a health check that fits the app,
//                  resources, volumes, generated passwords) — always valid
//   3. autoFix     for YAML written freely by a model or a person: pin images,
//                  add resources / probes / labels, fix units and apiVersions
import crypto from 'crypto'
import { APPS, IMAGE_TO_APP } from '../../config/appCatalog.js'

const NAME = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/
export const KINDS = ['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob']
const EXPOSE = ['none', 'cluster', 'nodeport', 'loadbalancer', 'ingress']
const toName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'app'
const QTY_MEM = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|K|M|G|T)?$/
const QTY_CPU = /^\d+(\.\d+)?m?$/

// ── 1a. understanding by rules (works without any AI) ──
const ALIASES = Object.entries(APPS).flatMap(([k, a]) => a.aliases.map(al => [al, k])).sort((x, y) => y[0].length - x[0].length)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// things the templates do not build — those go to the model as free-form YAML
const BEYOND = /\b(sidecar|init ?container|configmap with|config map with|autoscal|hpa\b|affinity|toleration|node ?selector|tls|certificate|cert-manager|helm|operator|crd|custom resource|service ?account with|rbac|role ?binding|kafka|zookeeper|elasticsearch|keycloak|wordpress|prometheus|grafana)\b/i

function memOf(t, words) {
    const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(mi|mb|gi|gb|m|g)\\b[^,.;]{0,12}\\b(${words})\\b|\\b(${words})\\b[^,.;\\d]{0,12}(\\d+(?:\\.\\d+)?)\\s*(mi|mb|gi|gb|m|g)\\b`, 'i')
    const m = re.exec(t)
    if (!m) return null
    const n = m[1] || m[5], u = (m[2] || m[6]).toLowerCase()
    return `${n}${u.startsWith('g') ? 'Gi' : 'Mi'}`
}
export function cronOf(t) {
    const quoted = /["'`]((?:[\d*/,-]+\s+){4}[\d*/,-]+)["'`]/.exec(t)
    if (quoted) return quoted[1]
    const hm = (h, m, ap) => { let H = Number(h) % 24; if (/pm|shaam|raat/.test(ap || '') && H < 12) H += 12; if (/am|subah/.test(ap || '') && H === 12) H = 0; return `${Number(m || 0)} ${H}` }
    let m
    if ((m = /every\s+(\d+)\s*(min|minute|minutes|mins)\b|har\s+(\d+)\s*(minute|min)/i.exec(t))) return `*/${m[1] || m[3]} * * * *`
    if ((m = /every\s+(\d+)\s*(hour|hours|hrs?)\b|har\s+(\d+)\s*(ghante|hour)/i.exec(t))) return `0 */${m[1] || m[3]} * * *`
    if (/every\s+minute|har\s+minute/i.test(t)) return '* * * * *'
    if (/every\s+hour|hourly|har\s+ghante/i.test(t)) return '0 * * * *'
    if ((m = /(?:every|each)\s+(?:night|day|morning|evening)?\s*at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|(?:daily|nightly)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t))) return `${hm(m[1] || m[4], m[2] || m[5], m[3] || m[6] || (/night/i.test(m[0]) ? 'am' : ''))} * * *`
    if ((m = /har\s+(raat|subah|shaam|din)\s+(\d{1,2})\s*baje/i.exec(t))) return `${hm(m[2], 0, m[1])} * * *`
    if ((m = /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(t))) return `${m[2] ? hm(m[2], m[3], m[4]) : '0 0'} * * ${['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(m[1].toLowerCase())}`
    if (/every\s+(night|day)|daily|nightly|har\s+(raat|din)|roz/i.test(t)) return '0 2 * * *'
    if (/every\s+week|weekly/i.test(t)) return '0 3 * * 0'
    return null
}
function commandOf(t, app) {
    const q = /\b(?:runs?|run karo|chalao|command)\s+["'`]([^"'`]{1,300})["'`]/i.exec(t)
    if (q) return ['sh', '-c', q[1]]
    if (/print(?:s|ing)? (?:the )?(?:current )?date|date print/i.test(t)) return ['sh', '-c', 'date']
    const echo = /print(?:s|ing)?\s+["'`]?([\w\s!.,-]{1,80}?)["'`]?(?:\s+(?:every|each|and|$)|$)/i.exec(t)
    if (echo && !/date/i.test(echo[1])) return ['sh', '-c', `echo "${echo[1].trim().replace(/"/g, '')}"`]
    return null
}

// "postgres 15" → postgres:15-alpine (the catalog's flavour, the asked version)
export function withVersion(image, version) {
    const [repo, tag = ''] = image.split(':')
    const flavour = tag.replace(/^[\d.]+/, '')
    return `${repo}:${version}${flavour}`
}

/** The request in words → { workloads: [intent], confident, reason } — no AI. */
export function parseIntent(description) {
    const t = ` ${String(description || '').toLowerCase().replace(/\s+/g, ' ')} `
    const hits = [], versions = {}
    // quoted text is a command, an image reference is not an app name (nginx:1.27-alpine is not alpine)
    let rest = t.replace(/(["'`])[^"'`]*\1/g, ' ').replace(/\bimage\s+\S+/g, ' ')
    for (const [alias, key] of ALIASES) {
        const re = new RegExp(`(^|[^a-z0-9:./-])${esc(alias)}(?![a-z0-9:/-])(?:\\s*[:v]?\\s*(\\d+(?:\\.\\d+){0,2})(?![\\d.]*\\s*(?:mi|gi|mb|gb|m\\b|g\\b|replica|cop|instance|pod|port|core|cpu)))?`, 'i')
        const m = re.exec(rest)
        if (m && !hits.some(h => h.key === key)) {
            hits.push({ key, at: m.index })
            if (m[2]) versions[key] = m[2]
            rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length)
        }
    }
    // in the order they were written
    const found = hits.sort((a, b) => a.at - b.at).map(h => h.key)
    const img = /\bimage\s+([a-z0-9][a-z0-9._/-]*(?::[\w][\w.-]*)?)/i.exec(description || '')
    const named = /\b(?:named|called|name)\s+["'`]?([a-z0-9][a-z0-9-]{0,40})["'`]?/i.exec(t)
    const schedule = cronOf(t)
    const kind = /\bcron ?job\b|\bschedule/.test(t) || schedule ? 'CronJob'
        : /\bdaemon ?set\b|every node|each node|har node|sab node/.test(t) ? 'DaemonSet'
            : /\bstateful ?set\b/.test(t) ? 'StatefulSet'
                : /\bjob\b|run once|ek baar/.test(t) ? 'Job'
                    : /\bpods?\b/.test(t) && !/\d+\s*pods?\b/.test(t) ? 'Pod'
                        : /\bdeployment\b/.test(t) ? 'Deployment' : null
    const replicas = Number((/(\d{1,3})\s*(?:replicas?|copies|instances|pods\b)|replicas?\s*[:=]?\s*(\d{1,3})/.exec(t) || []).slice(1).find(Boolean)) || null
    const port = Number((/\bport\s*[:=]?\s*(\d{2,5})\b|\b(\d{2,5})\s*port\b|\bon\s+(\d{2,5})\b|:(\d{2,5})\b/.exec(t) || []).slice(1).find(Boolean)) || null
    const memory = memOf(t, 'memory|ram|mem')
    const volume = memOf(t, 'volume|disk|storage|pvc|persistent') || (/\b(volume|persistent|persist)\b/.test(t) ? '1Gi' : null)
    const cpu = (/(\d+(?:\.\d+)?)\s*(cores?|vcpus?|cpus?)\b/.exec(t) || [])[1] || ((/(\d{2,4})m\s*cpu|cpu\s*(\d{2,4})m/.exec(t) || []).slice(1).find(Boolean) ? `${(/(\d{2,4})m\s*cpu|cpu\s*(\d{2,4})m/.exec(t)).slice(1).find(Boolean)}m` : null)
    const host = (/\b(?:host|domain|url|on)\s+((?:[a-z0-9-]+\.)+[a-z]{2,})\b/.exec(t) || [])[1] || null
    const expose = /\bload ?balancer\b|public ip|bahar se/.test(t) ? 'loadbalancer' : /\bnode ?port\b/.test(t) ? 'nodeport' : host || /\bingress\b/.test(t) ? 'ingress'
        : /\bservice\b|\bexpose|reachable|access/.test(t) ? 'cluster' : null
    const internal = /(only|just)\s+(reachable|accessible)\s+(inside|within|from)\s+(the\s+)?namespace|internal only|namespace ke andar|sirf namespace/.test(t)
    const env = {}
    for (const m of (description || '').matchAll(/\b([A-Z][A-Z0-9_]{1,40})=([^\s,;]+)/g)) env[m[1]] = m[2]

    const apps = found.length ? found : img ? [IMAGE_TO_APP[img[1].split(':')[0]] || null] : []
    if (!apps.length) return { workloads: [], confident: false, reason: 'no app or image recognised' }
    const workloads = apps.map((key, i) => {
        const a = key ? APPS[key] : null
        const w = {
            name: toName(i === 0 && named ? named[1] : key || img[1].split('/').pop().split(':')[0]), app: key, image: i === 0 && img ? img[1] : (key && versions[key] ? withVersion(APPS[key].image, versions[key]) : null),
            kind: kind || null, replicas: i === 0 ? replicas : null, port: i === 0 && port ? port : null,
            cpu: i === 0 && cpu ? String(cpu) : null, memory: i === 0 ? memory : null,
            volume: i === 0 && volume ? { size: volume } : (a?.database && !/no volume|without volume/.test(t) ? { size: '1Gi' } : null),
            expose: i === 0 && expose ? expose : (a?.port || (i === 0 && port) ? 'cluster' : 'none'), host: i === 0 ? host : null,
            schedule: kind === 'CronJob' ? (schedule || '0 2 * * *') : null, command: commandOf(t, a), env: i === 0 ? env : {}, internal
        }
        return w
    })
    return { workloads, confident: !BEYOND.test(t) && String(description).length <= 220, reason: BEYOND.test(t) ? 'asks for something the templates do not build' : null }
}

// ── 1b. understanding by the model: the same intent as JSON ──
export const INTENT_SYSTEM = `You turn a request for Kubernetes workloads into JSON for KubeEZ, which writes the YAML itself. Reply with ONLY:
{"workloads":[{"name":"short-dns-name","app":"one of: ${Object.keys(APPS).join(', ')} — or null","image":"repo:tag only if no app fits, else null","kind":"Deployment|StatefulSet|DaemonSet|Pod|Job|CronJob","replicas":number|null,"port":number|null,"cpu":"100m"|null,"memory":"128Mi"|null,"volume":{"size":"1Gi","mountPath":"/data"}|null,"expose":"none|cluster|nodeport|loadbalancer|ingress","host":"app.example.com"|null,"schedule":"cron like 0 2 * * *"|null,"command":["sh","-c","..."]|null,"env":{"KEY":"value"},"internal":true|false}],"freeform":false}
Set "freeform": true (and workloads: []) only when the request needs things this format cannot express (sidecars, init containers, config files, autoscaling, TLS, RBAC, operators).
Use null for anything not asked — KubeEZ fills good defaults. Never invent passwords.`

/** Model JSON → a checked intent (unknown apps / bad values dropped). */
export function cleanIntent(raw) {
    if (!raw || typeof raw !== 'object') return null
    if (raw.freeform) return { workloads: [], freeform: true }
    const list = Array.isArray(raw.workloads) ? raw.workloads.slice(0, 6) : []
    const out = []
    for (const w of list) {
        const app = APPS[w?.app] ? w.app : (w?.image && IMAGE_TO_APP[String(w.image).split(':')[0]]) || null
        const image = !app && /^[a-z0-9][a-z0-9._/-]*:[\w][\w.-]*$/i.test(String(w?.image || '')) ? String(w.image) : null
        if (!app && !image) continue
        const n = (v, min, max) => { const x = Number(v); return Number.isInteger(x) && x >= min && x <= max ? x : null }
        out.push({
            name: toName(w.name || app || image.split('/').pop().split(':')[0]), app, image,
            kind: KINDS.includes(w.kind) ? w.kind : null, replicas: n(w.replicas, 0, 50), port: n(w.port, 1, 65535),
            cpu: QTY_CPU.test(String(w.cpu || '')) ? String(w.cpu) : null, memory: QTY_MEM.test(String(w.memory || '')) ? String(w.memory) : null,
            volume: w.volume && QTY_MEM.test(String(w.volume.size || '')) ? { size: String(w.volume.size), mountPath: /^\/[\w./-]*$/.test(String(w.volume.mountPath || '')) ? String(w.volume.mountPath) : null } : null,
            expose: EXPOSE.includes(w.expose) ? w.expose : null, host: /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(String(w.host || '')) ? String(w.host).toLowerCase() : null,
            schedule: /^([\d*/,-]+\s+){4}[\d*/,-]+$/.test(String(w.schedule || '').trim()) ? String(w.schedule).trim() : null,
            command: Array.isArray(w.command) && w.command.every(x => typeof x === 'string') && w.command.length <= 10 ? w.command.map(x => x.slice(0, 500)) : null,
            env: w.env && typeof w.env === 'object' ? Object.fromEntries(Object.entries(w.env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 20).map(([k, v]) => [k, String(v).slice(0, 500)])) : {},
            internal: w.internal === true
        })
    }
    return out.length ? { workloads: out } : null
}

/** What KubeEZ understood, in words (shown above the YAML). */
export const describeIntent = (w) => [
    w.app ? (APPS[w.app].aliases[0]) : w.image, w.kind, w.replicas != null && w.kind !== 'Pod' && w.kind !== 'CronJob' && w.kind !== 'Job' ? `${w.replicas} replica(s)` : null,
    w.port ? `port ${w.port}` : null, w.memory ? `${w.memory} memory` : null, w.volume ? `${w.volume.size} volume` : null,
    w.schedule ? `schedule "${w.schedule}"` : null, w.expose && w.expose !== 'none' ? { cluster: 'service inside the cluster', nodeport: 'NodePort', loadbalancer: 'LoadBalancer', ingress: `ingress${w.host ? ` ${w.host}` : ''}` }[w.expose] : null,
    w.internal ? 'only reachable inside the namespace' : null
].filter(Boolean).join(' · ')

// ── 2. building the manifests ──
const pw = () => crypto.randomBytes(18).toString('base64url')
function probes(a, port) {
    if (!a?.probe && !port) return {}
    const d = a?.initialDelay || 5
    const p = a?.probe?.exec ? { exec: { command: a.probe.exec } } : a?.probe?.http && port ? { httpGet: { path: a.probe.http, port } } : port ? { tcpSocket: { port } } : null
    return p ? { readinessProbe: { ...p, initialDelaySeconds: d, periodSeconds: 10 }, livenessProbe: { ...p, initialDelaySeconds: d + 15, periodSeconds: 20, failureThreshold: 3 } } : {}
}

/** intent → { docs: [objects], notes: [text], secrets: [name] } */
export function buildFromIntent(intent, { namespace = 'default' } = {}) {
    const docs = [], notes = []
    const names = new Set()
    for (const raw of intent.workloads) {
        const w = { ...raw }
        const a = w.app ? APPS[w.app] : null
        let name = toName(w.name); while (names.has(name)) name = `${name}-2`; names.add(name)
        const labels = { 'app.kubernetes.io/name': name, 'app.kubernetes.io/managed-by': 'kubeez' }
        const meta = (n, extra = {}) => ({ name: n, labels, ...extra })
        let kind = w.kind || a?.kind || 'Deployment'
        const port = w.kind === 'CronJob' || w.kind === 'Job' ? null : (w.port || a?.port || null)
        // a disk that only one pod can mount, more than one replica → each needs its own: a StatefulSet
        if (w.volume && kind === 'Deployment' && (w.replicas || 1) > 1) { kind = 'StatefulSet'; notes.push(`${name}: a StatefulSet (not a Deployment) — with ${w.replicas} replicas each one needs its own volume`) }
        if (a?.base && !w.image) notes.push(`${name}: ${a.image} is a language image without your app — it is kept running so you can exec into it; for your service, put your own image (e.g. image registry.example.com/shop:1.0)`)
        if (kind === 'Pod') notes.push(`${name}: a single Pod is not restarted elsewhere if its node fails — ask for a Deployment for anything that must keep running`)

        // settings: passwords go into a Secret with a random value
        const env = [], secret = {}
        for (const [k, v] of Object.entries({ ...(a?.env || {}), ...(w.env || {}) })) {
            if (v && typeof v === 'object' && v.secret) { secret[k] = pw(); env.push({ name: k, valueFrom: { secretKeyRef: { name: `${name}-secret`, key: k } } }) }
            else env.push({ name: k, value: String(v) })
        }
        if (Object.keys(secret).length) {
            docs.push({ apiVersion: 'v1', kind: 'Secret', metadata: meta(`${name}-secret`), type: 'Opaque', stringData: secret })
            notes.push(`${name}: random password(s) in the Secret ${name}-secret (${Object.keys(secret).join(', ')}) — read with: kubectl -n ${namespace} get secret ${name}-secret -o jsonpath='{.data.${Object.keys(secret)[0]}}' | base64 -d`)
        }
        const mountPath = w.volume?.mountPath || a?.data || '/data'
        const container = {
            name, image: w.image || a?.image,
            ...(w.command || (a?.command && (!port || a.base)) ? { command: w.command || a.command } : {}),
            ...(port ? { ports: [{ name: 'main', containerPort: port }, ...(a?.extraPorts || []).map(p => ({ name: p.name, containerPort: p.port }))] } : {}),
            ...(env.length ? { env } : {}),
            resources: { requests: { cpu: w.cpu || a?.cpu || '50m', memory: w.memory || a?.memory || '64Mi' }, limits: { memory: w.memory ? w.memory : (a?.limit || '256Mi') } },
            ...(['Job', 'CronJob'].includes(kind) || (a?.base && !w.image) ? {} : probes(a, port)),
            securityContext: { allowPrivilegeEscalation: false },
            ...(w.volume ? { volumeMounts: [{ name: 'data', mountPath, ...(a?.dataSubPath ? { subPath: a.dataSubPath } : {}) }] } : {})
        }
        // a memory limit below the request is refused by Kubernetes
        if (w.memory && container.resources.requests.memory !== w.memory) container.resources.requests.memory = w.memory
        const podSpec = (extra = {}) => ({ securityContext: { seccompProfile: { type: 'RuntimeDefault' } }, containers: [container], ...extra })
        const pvc = (n) => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(n), spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: w.volume.size } } } })
        const volumes = w.volume && kind !== 'StatefulSet' ? [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }] : []
        if (w.volume && kind !== 'StatefulSet') docs.push(pvc(`${name}-data`))

        if (kind === 'Deployment') docs.push({ apiVersion: 'apps/v1', kind, metadata: meta(name), spec: { replicas: w.replicas ?? 1, selector: { matchLabels: { 'app.kubernetes.io/name': name } }, template: { metadata: { labels }, spec: podSpec(volumes.length ? { volumes } : {}) } } })
        if (kind === 'StatefulSet') docs.push({ apiVersion: 'apps/v1', kind, metadata: meta(name), spec: { serviceName: name, replicas: w.replicas ?? 1, selector: { matchLabels: { 'app.kubernetes.io/name': name } }, template: { metadata: { labels }, spec: podSpec() }, ...(w.volume ? { volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: w.volume.size } } } }] } : {}) } })
        if (kind === 'DaemonSet') docs.push({ apiVersion: 'apps/v1', kind, metadata: meta(name), spec: { selector: { matchLabels: { 'app.kubernetes.io/name': name } }, template: { metadata: { labels }, spec: podSpec(volumes.length ? { volumes } : {}) } } })
        if (kind === 'Pod') docs.push({ apiVersion: 'v1', kind, metadata: meta(name), spec: podSpec({ restartPolicy: 'Always', ...(volumes.length ? { volumes } : {}) }) })
        if (kind === 'Job') docs.push({ apiVersion: 'batch/v1', kind, metadata: meta(name), spec: { backoffLimit: 2, ttlSecondsAfterFinished: 3600, template: { metadata: { labels }, spec: podSpec({ restartPolicy: 'OnFailure', ...(volumes.length ? { volumes } : {}) }) } } })
        if (kind === 'CronJob') docs.push({ apiVersion: 'batch/v1', kind, metadata: meta(name), spec: { schedule: w.schedule || '0 2 * * *', concurrencyPolicy: 'Forbid', successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 3, jobTemplate: { spec: { backoffLimit: 2, template: { metadata: { labels }, spec: podSpec({ restartPolicy: 'OnFailure', ...(volumes.length ? { volumes } : {}) }) } } } } })

        // how it is reached
        const expose = w.expose || (port ? 'cluster' : 'none')
        if (port && (expose !== 'none' || kind === 'StatefulSet')) {
            const type = { nodeport: 'NodePort', loadbalancer: 'LoadBalancer' }[expose] || 'ClusterIP'
            const svcPort = port === 80 || type !== 'ClusterIP' ? port : port
            docs.push({ apiVersion: 'v1', kind: 'Service', metadata: meta(name), spec: { type, selector: { 'app.kubernetes.io/name': name }, ports: [{ name: 'main', port: svcPort, targetPort: port }, ...(a?.extraPorts || []).map(p => ({ name: p.name, port: p.port, targetPort: p.port }))] } })
            if (expose === 'ingress') {
                docs.push({ apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: meta(name), spec: { ingressClassName: 'nginx', rules: [{ ...(w.host ? { host: w.host } : {}), http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name, port: { number: svcPort } } } }] } }] } })
                if (!w.host) notes.push(`${name}: the Ingress answers every host name — add "host app.example.com" to the description for one`)
            }
        }
        if (w.internal) docs.push({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: meta(`${name}-internal`), spec: { podSelector: { matchLabels: { 'app.kubernetes.io/name': name } }, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: {} }] }] } })
    }
    return { docs, notes }
}

// ── 3. auto-fix for YAML written freely (by a model or a person) ──
const podSpecOf = (o) => o.kind === 'Pod' ? o.spec : o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : o.spec?.template?.spec
const API = { Deployment: 'apps/v1', StatefulSet: 'apps/v1', DaemonSet: 'apps/v1', Pod: 'v1', Service: 'v1', ConfigMap: 'v1', Secret: 'v1', PersistentVolumeClaim: 'v1', Job: 'batch/v1', CronJob: 'batch/v1', Ingress: 'networking.k8s.io/v1', NetworkPolicy: 'networking.k8s.io/v1', HorizontalPodAutoscaler: 'autoscaling/v2', PodDisruptionBudget: 'policy/v1', ServiceAccount: 'v1' }

/** Fix what can be fixed safely → { docs, fixes: [text] } */
export function autoFix(docs) {
    const fixes = []
    const fix = (o, text) => fixes.push(`${o.kind}/${o.metadata?.name || '?'}: ${text}`)
    for (const o of docs) {
        if (!o || typeof o !== 'object') continue
        if (API[o.kind] && o.apiVersion !== API[o.kind]) { fix(o, `apiVersion ${o.apiVersion || 'missing'} → ${API[o.kind]}`); o.apiVersion = API[o.kind] }
        o.metadata ||= {}
        if (o.metadata.name && !NAME.test(o.metadata.name)) { const n = toName(o.metadata.name); fix(o, `name "${o.metadata.name}" → "${n}"`); o.metadata.name = n }
        // workloads: labels and selector must match
        if (['Deployment', 'StatefulSet', 'DaemonSet'].includes(o.kind) && o.spec && o.metadata.name) {
            o.spec.template ||= {}; o.spec.template.metadata ||= {}; o.spec.template.metadata.labels ||= {}
            const sel = o.spec.selector?.matchLabels
            if (!sel || !Object.keys(sel).length) { o.spec.selector = { matchLabels: { 'app.kubernetes.io/name': o.metadata.name } }; fix(o, 'selector added') }
            for (const [k, v] of Object.entries(o.spec.selector.matchLabels)) if (o.spec.template.metadata.labels[k] !== v) { o.spec.template.metadata.labels[k] = v; fix(o, `pod label ${k}=${v} added so the selector finds its pods`) }
            if (o.kind === 'StatefulSet' && !o.spec.serviceName) { o.spec.serviceName = o.metadata.name; fix(o, 'serviceName added') }
        }
        const spec = podSpecOf(o)
        if (!spec) continue
        if ((o.kind === 'Job' || o.kind === 'CronJob') && !['OnFailure', 'Never'].includes(spec.restartPolicy)) { spec.restartPolicy = 'OnFailure'; fix(o, 'restartPolicy → OnFailure (a job must end)') }
        for (const c of spec.containers || []) {
            const repo = String(c.image || '').split(':')[0]
            const known = APPS[IMAGE_TO_APP[repo]]
            if (known && (!/:[\w][\w.-]*$/.test(c.image || '') || /:latest$/.test(c.image))) { fix(o, `image ${c.image} → ${known.image} (pinned)`); c.image = known.image }
            c.resources ||= {}; c.resources.requests ||= {}; c.resources.limits ||= {}
            for (const where of ['requests', 'limits']) {
                const r = c.resources[where]
                if (r.cpu != null && !QTY_CPU.test(String(r.cpu))) { fix(o, `${where}.cpu "${r.cpu}" is not a CPU amount → ${where === 'requests' ? (known?.cpu || '100m') : 'removed'}`); if (where === 'requests') r.cpu = known?.cpu || '100m'; else delete r.cpu }
                if (r.memory != null && !QTY_MEM.test(String(r.memory))) { const m = /^(\d+)\s*(m|mb|g|gb)$/i.exec(String(r.memory)); const v = m ? `${m[1]}${/^g/i.test(m[2]) ? 'Gi' : 'Mi'}` : (known?.limit || '256Mi'); fix(o, `${where}.memory "${r.memory}" → ${v}`); r.memory = v }
            }
            if (!c.resources.requests.cpu) { c.resources.requests.cpu = known?.cpu || '50m'; fix(o, `container ${c.name}: CPU request added`) }
            if (!c.resources.requests.memory) { c.resources.requests.memory = known?.memory || '64Mi'; fix(o, `container ${c.name}: memory request added`) }
            if (!c.resources.limits.memory) { c.resources.limits.memory = known?.limit || '256Mi'; fix(o, `container ${c.name}: memory limit added`) }
            // a limit below the request is refused
            const b = (q) => { const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti)?$/.exec(String(q)); return m ? Number(m[1]) * ({ Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[m[2]] || 1) : null }
            if (b(c.resources.limits.memory) != null && b(c.resources.requests.memory) > b(c.resources.limits.memory)) { c.resources.requests.memory = c.resources.limits.memory; fix(o, `container ${c.name}: memory request lowered to the limit`) }
            const port = c.ports?.[0]?.containerPort
            if (known && port && !c.readinessProbe && !['Job', 'CronJob'].includes(o.kind)) { Object.assign(c, probes(known, port)); fix(o, `container ${c.name}: health checks for ${repo} added`) }
        }
    }
    return { docs, fixes }
}
