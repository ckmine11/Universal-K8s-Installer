// Text → YAML: describe what you want, KubeEZ AI writes the manifests, KubeEZ
// checks them (allowed kinds, no privileged / host access, limits, pinned
// images), dry-runs them on the cluster and shows the diff. Apply keeps what
// was there before, so Undo deletes what was created and puts back what was
// changed.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { parseAllDocuments, stringify } from 'yaml'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import { ask } from './engine.js'
import { parseIntent, cleanIntent, buildFromIntent, describeIntent, autoFix, INTENT_SYSTEM } from './yamlBuilder.js'
import { APPS } from '../../config/appCatalog.js'

const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
const MAX_BYTES = 100 * 1024
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

// what may be created from a description (namespaced only — no RBAC, CRDs, nodes, webhooks)
export const ALLOWED_KINDS = {
    Deployment: 'apps/v1', StatefulSet: 'apps/v1', DaemonSet: 'apps/v1', Service: 'v1', ConfigMap: 'v1', Secret: 'v1',
    PersistentVolumeClaim: 'v1', Pod: 'v1', Job: 'batch/v1', CronJob: 'batch/v1', Ingress: 'networking.k8s.io/v1', NetworkPolicy: 'networking.k8s.io/v1',
    HorizontalPodAutoscaler: 'autoscaling/v2', PodDisruptionBudget: 'policy/v1', ServiceAccount: 'v1'
}
// every allowed kind must be here — undo deletes by it (a missing one was silently skipped)
const PLURAL = { Pod: 'pod', Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset', Service: 'service', ConfigMap: 'configmap', Secret: 'secret', PersistentVolumeClaim: 'pvc', Job: 'job', CronJob: 'cronjob', Ingress: 'ingress', NetworkPolicy: 'networkpolicy', HorizontalPodAutoscaler: 'hpa', PodDisruptionBudget: 'pdb', ServiceAccount: 'serviceaccount' }

export const GENERATE_SYSTEM = `You write Kubernetes manifests for KubeEZ from a description. Output ONLY YAML documents separated by "---" — no explanations, no code fences.
Rules:
- Only these kinds: ${Object.keys(ALLOWED_KINDS).join(', ')}. Use the apiVersions ${[...new Set(Object.values(ALLOWED_KINDS))].join(', ')}.
- Do not set metadata.namespace (KubeEZ sets it).
- Label everything with app.kubernetes.io/name; selectors must match the pod labels.
- Every container: a pinned image tag (never :latest), resources.requests and resources.limits for cpu and memory, readiness and liveness probes when it serves a port.
- Never privileged, hostNetwork, hostPID, hostIPC, hostPath or added capabilities; runAsNonRoot when the image supports it.
- Services are ClusterIP unless a NodePort or LoadBalancer is asked for. Ingress uses ingressClassName nginx.
- Never put real passwords in a Secret — use a placeholder like CHANGE_ME and say nothing else.`

/** YAML text → documents (fences and prose around it removed). */
export function parseManifests(text) {
    let t = String(text || '')
    // several fenced blocks (models often put each object in its own) → separate documents
    const blocks = [...t.matchAll(/```(?:ya?ml)?\s*\n([\s\S]*?)```/gi)].map(m => m[1].trim()).filter(Boolean)
    t = blocks.length ? blocks.join('\n---\n') : t.replace(/```(?:ya?ml)?/gi, '').trim()
    const first = t.search(/^(apiVersion|kind):/m)
    if (first > 0) t = t.slice(first)
    // objects written one after another without "---": a second top-level apiVersion/kind starts a new one
    const lines = [], seen = new Set()
    for (const l of t.split('\n')) {
        if (/^---/.test(l)) seen.clear()
        const top = /^(apiVersion|kind):/.exec(l)
        if (top && seen.has(top[1])) { lines.push('---'); seen.clear() }
        if (top) seen.add(top[1])
        lines.push(l)
    }
    t = lines.join('\n')
    if (Buffer.byteLength(t) > MAX_BYTES) throw bad('Too large — at most 100 KB of YAML')
    const docs = parseAllDocuments(t)
    const out = []
    for (const d of docs) {
        if (d.errors?.length) throw bad(`YAML error: ${d.errors[0].message.split('\n')[0]}`)
        const o = d.toJS()
        if (o && typeof o === 'object') out.push(o)
    }
    if (!out.length) throw bad('No Kubernetes objects found')
    if (out.length > 20) throw bad('At most 20 objects at a time')
    return out
}

const podSpecOf = (o) => o.kind === 'Pod' ? o.spec : o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec : ['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(o.kind) ? o.spec?.template?.spec : null

/** Check and normalise: → { objects, yaml, problems: [{ level: 'block'|'warn', object, text }] } */
export function checkManifests(docs, { namespace }) {
    if (!NAME.test(namespace || '')) throw bad('Pick a valid namespace')
    const problems = [], objects = []
    const add = (level, o, text) => problems.push({ level, object: `${o.kind || '?'}/${o.metadata?.name || '?'}`, text })
    for (const o of docs) {
        if (!ALLOWED_KINDS[o.kind]) { add('block', o, `${o.kind || 'This kind'} cannot be created from here (only ${Object.keys(ALLOWED_KINDS).join(', ')})`); continue }
        if (!o.apiVersion) o.apiVersion = ALLOWED_KINDS[o.kind]
        else if (o.apiVersion !== ALLOWED_KINDS[o.kind]) { add('warn', o, `apiVersion ${o.apiVersion} corrected to ${ALLOWED_KINDS[o.kind]}`); o.apiVersion = ALLOWED_KINDS[o.kind] }
        if (!NAME.test(o.metadata?.name || '')) { add('block', o, 'Missing or invalid metadata.name'); continue }
        if (o.metadata.namespace && o.metadata.namespace !== namespace) add('warn', o, `Namespace ${o.metadata.namespace} replaced by ${namespace}`)
        o.metadata.namespace = namespace
        const spec = podSpecOf(o)
        if (spec) {
            if (spec.hostNetwork || spec.hostPID || spec.hostIPC) add('block', o, 'Uses the node\'s network / processes (hostNetwork, hostPID or hostIPC)')
            if ((spec.volumes || []).some(v => v.hostPath)) add('block', o, 'Mounts a folder of the node (hostPath)')
            for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
                const sc = c.securityContext || {}
                if (sc.privileged) add('block', o, `Container ${c.name} is privileged`)
                if ((sc.capabilities?.add || []).some(x => /^(ALL|SYS_ADMIN|NET_ADMIN|SYS_PTRACE|SYS_MODULE)$/i.test(x))) add('block', o, `Container ${c.name} adds powerful capabilities (${sc.capabilities.add.join(', ')})`)
                if (sc.allowPrivilegeEscalation === true) add('warn', o, `Container ${c.name} allows privilege escalation`)
                if (sc.runAsUser === 0) add('warn', o, `Container ${c.name} runs as root`)
                if (!c.image || !/:[\w][\w.-]*$|@sha256:/.test(c.image) || /:latest$/.test(c.image)) add('warn', o, `Container ${c.name}: pin an image version (${c.image || 'no image'})`)
                if (!c.resources?.limits?.memory || !c.resources?.requests?.cpu) add('warn', o, `Container ${c.name}: set CPU / memory requests and a memory limit`)
                // a CPU amount is cores or millicores (500m, 0.5, 2); memory has a byte unit (64Mi, 1Gi)
                for (const [where, r] of [['requests', c.resources?.requests], ['limits', c.resources?.limits]]) {
                    if (r?.cpu != null && !/^\d+(\.\d+)?m?$/.test(String(r.cpu))) add('block', o, `Container ${c.name}: ${where}.cpu "${r.cpu}" is not a CPU amount (use e.g. 100m or 0.5)`)
                    if (r?.memory != null && !/^\d+(\.\d+)?([EPTGMK]i?|[kmM])?$/.test(String(r.memory))) add('block', o, `Container ${c.name}: ${where}.memory "${r.memory}" is not a memory amount (use e.g. 64Mi or 1Gi)`)
                }
                if ((c.ports || []).length && !c.readinessProbe && o.kind !== 'Job' && o.kind !== 'CronJob') add('warn', o, `Container ${c.name}: no readiness probe — traffic may arrive before it is ready`)
            }
        }
        if (o.kind === 'Service' && ['NodePort', 'LoadBalancer'].includes(o.spec?.type)) add('warn', o, `Reachable from outside the cluster (${o.spec.type})`)
        if (o.kind === 'Secret' && JSON.stringify(o.data || o.stringData || {}).match(/CHANGE_ME/)) add('warn', o, 'Fill in the secret values before applying (placeholders found)')
        objects.push({ kind: o.kind, name: o.metadata.name, namespace })
    }
    const okDocs = docs.filter(o => ALLOWED_KINDS[o.kind] && NAME.test(o.metadata?.name || ''))
    return { objects, problems, blocked: problems.some(p => p.level === 'block'), yaml: okDocs.map(o => stringify(o, { aliasDuplicateObjects: false }).trim()).join('\n---\n') + '\n' }
}

/** Ask the model for manifests; parse + check them. */
const toYaml = (docs) => docs.map(o => stringify(o, { aliasDuplicateObjects: false }).trim()).join('\n---\n') + '\n'
const engineOf = (r) => r ? { provider: r.provider, model: r.model, ms: r.ms, traceId: r.traceId } : null

// what the cluster needs for these objects (add-ons) — said before the dry-run
function clusterNotes(docs, addons = []) {
    const has = (k) => addons.includes(k)
    const out = []
    if (docs.some(o => o.kind === 'Ingress') && !has('ingress')) out.push('An Ingress needs an ingress controller — install the Nginx Ingress add-on on this cluster (or use a NodePort / LoadBalancer).')
    if (docs.some(o => o.kind === 'PersistentVolumeClaim' || o.spec?.volumeClaimTemplates) && !has('longhorn') && !has('nfs-provisioner')) out.push('Volumes need storage: install the Longhorn or NFS add-on, or make sure the cluster has a default StorageClass — otherwise the volume stays Pending.')
    if (docs.some(o => o.kind === 'Service' && o.spec?.type === 'LoadBalancer') && !has('metallb')) out.push('A LoadBalancer Service needs MetalLB on your own servers — install the MetalLB add-on, or the external IP stays pending.')
    return out
}

/**
 * Description → checked manifests, the most reliable way first:
 *   templates   the rules understood it → KubeEZ builds it (instant, no AI)
 *   ai-intent   the model says what is wanted (short JSON) → KubeEZ builds it
 *   ai-yaml     only for what the templates cannot build: the model writes YAML,
 *               KubeEZ fixes what it can and asks once more with the errors
 */
export async function generateManifests(user, { description, namespace, context = '', addons = [] }) {
    const d = String(description || '').trim()
    if (d.length < 3) throw bad('Describe what you want (e.g. "nginx 1.27 with 2 replicas and a service on port 80")')
    const rule = parseIntent(d)
    let intent = null, method = null, engine = null, aiError = null

    if (rule.confident && rule.workloads.length) { intent = rule; method = 'templates' }
    else {
        try {
            const r = await ask(user, {
                task: 'chat', purpose: 'text to YAML (understand)', json: true, english: false, maxTokens: 500, timeoutMs: 300000, system: INTENT_SYSTEM,
                validate: (j) => Array.isArray(j.workloads) || j.freeform ? null : 'needs "workloads"',
                data: [{ label: 'known apps', text: Object.entries(APPS).map(([k, a]) => `${k} (${a.image})`).join(', ') }, ...(context ? [{ label: 'cluster facts', text: context }] : [])],
                question: d.slice(0, 2000)
            })
            engine = engineOf(r)
            const c = cleanIntent(r.json)
            if (c?.workloads?.length) { intent = c; method = 'ai-intent' }
            else if (!c?.freeform && rule.workloads.length) { intent = rule; method = 'templates' }
        } catch (e) { aiError = e.message; if (rule.workloads.length) { intent = rule; method = 'templates' } }
    }

    if (intent) {
        const { docs, notes } = buildFromIntent(intent, { namespace })
        const checked = checkManifests(docs, { namespace })
        if (method === 'templates' && !rule.confident) notes.unshift('Built the main app from the description — the parts KubeEZ cannot build from text (' + (rule.reason || 'extras') + ') are not included; add them to the YAML.')
        if (aiError) notes.unshift('KubeEZ AI could not answer, so KubeEZ built it from the description itself.')
        return { ...checked, method, understood: intent.workloads.map(describeIntent), notes: [...notes, ...clusterNotes(docs, addons)], fixes: [], engine }
    }
    if (aiError) throw bad(`${aiError} — and KubeEZ could not recognise an app in the description. Name the app or image, e.g. "nginx with 2 replicas" or "image myrepo/app:1.0 on port 8080".`, 503)

    // free-form: the model writes the YAML; KubeEZ fixes it, and asks once more if needed
    const write = (question, data = []) => ask(user, {
        task: 'chat', purpose: 'text to YAML', english: false, maxTokens: 1200, timeoutMs: 300000, system: GENERATE_SYSTEM,
        data: [...(context ? [{ label: 'cluster facts', text: context }] : []), ...data], question
    })
    let r = await write(d.slice(0, 2000))
    let docs, fixes = [], checked
    for (let round = 1; round <= 2; round++) {
        let problem = null
        try {
            docs = parseManifests(r.text)
            const f = autoFix(docs); docs = f.docs; fixes = f.fixes
            checked = checkManifests(docs, { namespace })
            if (checked.blocked) problem = checked.problems.filter(p => p.level === 'block').map(p => `${p.object}: ${p.text}`).join('; ')
        } catch (e) { problem = e.message }
        if (!problem || round === 2) { if (problem && !checked) throw bad(`KubeEZ AI could not write valid YAML for this (${problem}). Try a simpler description, or one app at a time.`); break }
        r = await write(`${d.slice(0, 1500)}\n\nYour previous YAML had these problems: ${problem}\nWrite it again, fixed, following every rule.`, [{ label: 'previous YAML', text: String(r.text).slice(0, 6000) }])
    }
    return { ...checked, method: 'ai-yaml', understood: [], notes: clusterNotes(docs, addons), fixes, engine: engineOf(r) }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const pipe = (yaml) => `echo ${b64(yaml)} | base64 -d`
const out = (r) => `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim()

/** Server-side dry-run and the diff against what is in the cluster now. */
export async function previewManifests(ssh, yaml, objects) {
    const ns = objects[0]?.namespace
    const nsExists = ns ? (await ssh.execCommand(`${KUBECTL} get namespace ${ns} -o name`)).code === 0 : true
    if (!nsExists) return { ok: false, dryRun: `Namespace ${ns} does not exist — create it first`, diff: '', existing: [] }
    const dr = await ssh.execCommand(`${pipe(yaml)} | ${KUBECTL} apply --dry-run=server -f - 2>&1`)
    const df = await ssh.execCommand(`${pipe(yaml)} | ${KUBECTL} diff -f - 2>&1`)
    const existing = []
    for (const o of objects) if ((await ssh.execCommand(`${KUBECTL} -n ${o.namespace} get ${PLURAL[o.kind]} ${o.name} -o name 2>/dev/null`)).code === 0) existing.push(`${o.kind}/${o.name}`)
    // kubectl diff: 0 = no change, 1 = changes, >1 = error
    return { ok: dr.code === 0 && df.code <= 1, dryRun: out(dr).slice(0, 4000), diff: out(df).replace(/^diff -u -N .*$/gm, '').slice(0, 12000), existing }
}

// ── applied manifests (for undo) ──
const FILE = path.join(DATA_DIR, 'ai-manifests.json')
let cache = null
const load = () => { if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = [] } } return cache }
const persist = () => { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load().slice(0, 200))) }
export const manifestLog = { list: (orgId, clusterId) => load().filter(m => m.orgId === orgId && (!clusterId || m.clusterId === clusterId)), get: (id) => load().find(m => m.id === id), _reset() { cache = null } }
export const manifestView = ({ before, ...m }) => ({ ...m, canUndo: m.status === 'applied' && Date.now() - Date.parse(m.at) < 24 * 3600e3 })

// what an object looked like, ready to be put back
function restorable(obj) {
    const o = JSON.parse(JSON.stringify(obj))
    if (o.metadata) for (const k of ['resourceVersion', 'uid', 'creationTimestamp', 'generation', 'managedFields', 'selfLink']) delete o.metadata[k]
    if (o.metadata?.annotations) { delete o.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration']; delete o.metadata.annotations['deployment.kubernetes.io/revision'] }
    delete o.status
    return o
}

/** Apply for real — after taking a copy of what is there, so it can be undone. */
export async function applyManifests(ssh, { yaml, objects }, { orgId, cluster, user, description }) {
    const before = []
    for (const o of objects) {
        const r = await ssh.execCommand(`${KUBECTL} -n ${o.namespace} get ${PLURAL[o.kind]} ${o.name} -o json 2>/dev/null`)
        before.push({ ...o, existed: r.code === 0, object: r.code === 0 ? restorable(JSON.parse(r.stdout)) : null })
    }
    const r = await ssh.execCommand(`${pipe(yaml)} | ${KUBECTL} apply -f - 2>&1`)
    if (r.code !== 0) throw bad(`Kubernetes refused it: ${out(r).slice(0, 400)}`, 502)
    const rec = {
        id: randomBytes(6).toString('hex'), orgId, clusterId: cluster.id, clusterName: cluster.clusterName, by: user.username, at: new Date().toISOString(),
        description: String(description || '').slice(0, 300), objects, created: before.filter(b => !b.existed).map(b => `${b.kind}/${b.name}`), changed: before.filter(b => b.existed).map(b => `${b.kind}/${b.name}`),
        output: out(r).slice(0, 2000), status: 'applied', before
    }
    load().unshift(rec); persist()
    return rec
}

/** Undo: delete what was created, put back what was changed. */
export async function undoManifests(ssh, rec, user) {
    if (!rec) throw bad('Not found', 404)
    if (rec.status !== 'applied') throw bad('Already undone')
    if (Date.now() - Date.parse(rec.at) > 24 * 3600e3) throw bad('Undo is possible for 24 hours')
    const lines = []
    for (const b of rec.before) {
        if (!NAME.test(b.name) || !NAME.test(b.namespace) || !PLURAL[b.kind]) continue
        const r = b.existed
            ? await ssh.execCommand(`${pipe(JSON.stringify(b.object))} | ${KUBECTL} replace -f - 2>&1`)
            : await ssh.execCommand(`${KUBECTL} -n ${b.namespace} delete ${PLURAL[b.kind]} ${b.name} --ignore-not-found 2>&1`)
        lines.push(`${b.existed ? 'restored' : 'deleted'} ${b.kind}/${b.name}: ${r.code === 0 ? 'ok' : out(r).slice(0, 200)}`)
    }
    Object.assign(rec, { status: 'undone', undoneBy: user.username, undoneAt: new Date().toISOString(), undoOutput: lines.join('\n') })
    persist()
    return rec
}
