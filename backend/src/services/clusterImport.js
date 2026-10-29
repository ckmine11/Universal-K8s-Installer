// Connecting an existing cluster (cloud or on-prem) to KubeEZ.
//
// A connect session gives the user one command, run wherever their kubectl
// already works (their laptop, a bastion, a control-plane node):
//   · connect script (sh / PowerShell) — creates the `kubeez` ServiceAccount and
//     sends KubeEZ only the API address, its CA and that account's token. Works
//     the same for EKS / GKE / AKS logins (aws, gcloud, kubelogin stay on the
//     user's machine — KubeEZ never needs them).
//   · agent manifest — the same account plus the KubeEZ agent, which connects
//     out to KubeEZ (private endpoints, NAT, on-prem behind KubeEZ Cloud).
//   · or the kubeconfig itself, pasted: KubeEZ uses it once to create the
//     `kubeez` account, then forgets it.
// The cluster is checked (reachable, the token works, what it is) before it
// is saved. Access: read (watch, explain, advise) or full (also change things).
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { parse as parseYaml } from 'yaml'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'
import { isPrivateAddress } from '../utils/netGuard.js'
import { runSandboxed, apiTarget, closeForwarders, ACCESS_LEVELS, usesApi } from './clusterAccess.js'
import { detectCluster, providerById } from '../config/clusterProviders.js'

export const NS = 'kubeez-system'
const SESSIONS = path.join(DATA_DIR, 'import-sessions.json')
const SESSION_TTL = 24 * 3600e3
export const METHODS = ['auto', 'direct', 'gateway', 'agent']

let sessions = null
const load = () => { if (!sessions) { try { sessions = JSON.parse(fs.readFileSync(SESSIONS, 'utf8')) } catch { sessions = {} } } return sessions }
const persist = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(SESSIONS, JSON.stringify(load())) } catch { } }
const sweep = () => { const all = load(); let changed = false; for (const [k, s] of Object.entries(all)) if (Date.now() - Date.parse(s.createdAt) > SESSION_TTL) { delete all[k]; changed = true } if (changed) persist() }
const bad = (m, extra = {}) => Object.assign(new Error(m), { status: 400, ...extra })
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/

/** A new connect session (or a reconnect of an existing cluster). */
export function startSession(user, { name, provider = 'cloud-other', method = 'auto', level = 'read', clusterId = null, labels = null } = {}) {
    sweep()
    if (!NAME.test(String(name || ''))) throw bad('Name: 1–63 letters, numbers, spaces, ".", "-" or "_"')
    if (!providerById(provider)) throw bad('Unknown provider')
    if (!METHODS.includes(method)) throw bad('Method: auto, direct, gateway or agent')
    if (!ACCESS_LEVELS.includes(level)) throw bad('Access: read or full')
    if (providerById(provider).agentOnly && method !== 'agent') method = 'agent'
    const code = randomBytes(18).toString('base64url')
    const s = { code, orgId: user.orgId, ownerId: user.id, ownerUsername: user.username, name: String(name).trim(), provider, method, level, clusterId: clusterId || `imp-${randomBytes(6).toString('hex')}`, reconnect: !!clusterId, labels, status: 'waiting', createdAt: new Date().toISOString() }
    load()[code] = s; persist()
    return s
}
export const getSession = (code) => { sweep(); return load()[String(code || '')] || null }
const update = (code, patch) => { const s = load()[code]; if (s) { Object.assign(s, patch, { updatedAt: new Date().toISOString() }); persist() } return s }
export function sessionView(s) {
    if (!s) return null
    const { code, name, provider, method, level, clusterId, status, error, hint, createdAt, route, detected, reconnect } = s
    return { code, name, provider, method, level, clusterId, status, error: error || null, hint: hint || null, createdAt, route: route || null, detected: detected || null, reconnect: !!reconnect }
}

// ── what is applied in the cluster ──────────────────────────────────────────
// read: everything except Secrets (the built-in `view` role + cluster-wide reads).
// No nodes/proxy and no services/proxy: those reach the kubelet / Services and
// are more than reading. full: cluster-admin.
const READ_RULES = `rules:
  - apiGroups: [""]
    resources: [nodes, namespaces, persistentvolumes, events, componentstatuses, resourcequotas, limitranges]
    verbs: [get, list, watch]
  - apiGroups: [storage.k8s.io, apiextensions.k8s.io, rbac.authorization.k8s.io, admissionregistration.k8s.io, apiregistration.k8s.io, scheduling.k8s.io, node.k8s.io, networking.k8s.io, policy, certificates.k8s.io, coordination.k8s.io, discovery.k8s.io, metrics.k8s.io, autoscaling, batch, apps, flowcontrol.apiserver.k8s.io, events.k8s.io, snapshot.storage.k8s.io, velero.io, monitoring.coreos.com, cert-manager.io, gateway.networking.k8s.io, argoproj.io, kustomize.toolkit.fluxcd.io, helm.toolkit.fluxcd.io, source.toolkit.fluxcd.io, aquasecurity.github.io, keda.sh]
    resources: ["*"]
    verbs: [get, list, watch]
  # External Secrets: only the sync objects (their status) — never its generators' state
  - apiGroups: [external-secrets.io]
    resources: [externalsecrets, secretstores, clustersecretstores]
    verbs: [get, list, watch]
  - nonResourceURLs: [/healthz, /livez, /readyz, /version, /version/]
    verbs: [get]`
export function accessManifest(level) {
    const lvl = level === 'full' ? 'full' : 'read'
    return `# KubeEZ access — the \`kubeez\` login KubeEZ uses for this cluster (${lvl === 'full' ? 'Full manage' : 'Read-only'}).
# Remove it at any time: kubectl delete namespace ${NS}; kubectl delete clusterrolebinding kubeez-read kubeez-view kubeez-full --ignore-not-found; kubectl delete clusterrole kubeez-read --ignore-not-found
apiVersion: v1
kind: Namespace
metadata:
  name: ${NS}
  labels: { app.kubernetes.io/managed-by: kubeez }
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: kubeez
  namespace: ${NS}
  labels: { app.kubernetes.io/managed-by: kubeez }
---
apiVersion: v1
kind: Secret
metadata:
  name: kubeez-token
  namespace: ${NS}
  labels: { app.kubernetes.io/managed-by: kubeez }
  annotations: { kubernetes.io/service-account.name: kubeez }
type: kubernetes.io/service-account-token
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeez-read
  labels: { app.kubernetes.io/managed-by: kubeez }
${READ_RULES}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-read
  labels: { app.kubernetes.io/managed-by: kubeez }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kubeez-read }
subjects: [{ kind: ServiceAccount, name: kubeez, namespace: ${NS} }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-view
  labels: { app.kubernetes.io/managed-by: kubeez }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: kubeez, namespace: ${NS} }]
${lvl === 'full' ? `---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-full
  labels: { app.kubernetes.io/managed-by: kubeez }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: cluster-admin }
subjects: [{ kind: ServiceAccount, name: kubeez, namespace: ${NS} }]
` : ''}`
}
export const CLEANUP = `kubectl delete namespace ${NS} --ignore-not-found; kubectl delete clusterrolebinding kubeez-read kubeez-view kubeez-full --ignore-not-found; kubectl delete clusterrole kubeez-read --ignore-not-found`

/** The access manifest plus the KubeEZ agent (outbound only). */
export async function agentManifest(s, baseUrl) {
    const { agentService } = await import('./agentService.js')
    let agentId = s.agentId, token = null
    const existing = agentId && await agentService.getAgentById(agentId)
    if (existing) token = existing.token
    else {
        const rec = await agentService.generateToken(s.ownerId, s.ownerUsername, s.orgId, `In-cluster agent — ${s.name}`, { kind: 'cluster', clusterId: s.clusterId })
        agentId = rec.agentId; token = rec.token
        update(s.code, { agentId })
    }
    const ws = baseUrl.replace(/^http/, 'ws')
    const insecure = !/^wss:/.test(ws)
    const cfg = JSON.stringify({ token, agentId, server: ws, cluster: true, ...(insecure ? { allowInsecure: true } : {}) })
    return `${accessManifest(s.level)}---
# The KubeEZ agent: connects OUT to KubeEZ (no inbound port), and only reaches
# this cluster's API and Services. Remove it with the namespace above.
apiVersion: v1
kind: Secret
metadata:
  name: kubeez-agent
  namespace: ${NS}
  labels: { app.kubernetes.io/managed-by: kubeez }
stringData:
  config.json: '${cfg}'
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: kubeez-agent
  namespace: ${NS}
  labels: { app.kubernetes.io/name: kubeez-agent, app.kubernetes.io/managed-by: kubeez }
spec:
  replicas: 1
  selector: { matchLabels: { app.kubernetes.io/name: kubeez-agent } }
  template:
    metadata:
      labels: { app.kubernetes.io/name: kubeez-agent }
    spec:
      serviceAccountName: kubeez
      # (OpenShift picks the user itself — a fixed runAsUser is refused there)
      securityContext: { runAsNonRoot: true,${s.provider === 'openshift' ? '' : ' runAsUser: 1000, runAsGroup: 1000,'} seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: agent
          image: node:22-alpine
          command: [sh, -c, 'wget -qO /tmp/agent.js "$KUBEEZ_URL/agent-bundle.js" && exec node /tmp/agent.js --config /etc/kubeez-agent/config.json']
          env:
            - { name: KUBEEZ_URL, value: "${baseUrl}" }
            - { name: KUBEEZ_AGENT_IN_CLUSTER, value: "1" }
          resources:
            requests: { cpu: 10m, memory: 48Mi }
            limits: { memory: 192Mi }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          volumeMounts:
            - { name: config, mountPath: /etc/kubeez-agent, readOnly: true }
            - { name: token, mountPath: /var/run/kubeez, readOnly: true }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - { name: config, secret: { secretName: kubeez-agent } }
        - { name: token, secret: { secretName: kubeez-token } }
        - { name: tmp, emptyDir: {} }
`
}

// ── the same agent as a Helm chart ──────────────────────────────────────────
// helm upgrade --install kubeez-agent <link>/agent-chart.tgz -n kubeez-system --create-namespace
// (the Namespace comes from Helm then, so it is not in the chart)
function tar(files) {
    const blocks = []
    const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
    for (const [name, text] of files) {
        const data = Buffer.from(text, 'utf8')
        const h = Buffer.alloc(512)
        const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'
        h.write(name.slice(0, 100), 0, 100, 'utf8')
        h.write(oct(0o644, 8), 100, 8); h.write(oct(0, 8), 108, 8); h.write(oct(0, 8), 116, 8)
        h.write(oct(data.length, 12), 124, 12); h.write(oct(Math.floor(Date.now() / 1000), 12), 136, 12)
        h.write('        ', 148, 8); h.write('0', 156, 1); h.write('ustar\0', 257, 6); h.write('00', 263, 2)
        let sum = 0; for (const b of h) sum += b
        h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
        blocks.push(h, pad(data))
    }
    blocks.push(Buffer.alloc(1024))
    return Buffer.concat(blocks)
}
export async function agentChart(s, baseUrl) {
    const { gzipSync } = await import('zlib')
    const manifest = (await agentManifest(s, baseUrl)).split(/^---$/m).filter(doc => !/^kind: Namespace$/m.test(doc)).join('---')
    const chart = `apiVersion: v2\nname: kubeez-agent\ndescription: The KubeEZ agent and its kubeez login — connects this cluster to KubeEZ (outbound only)\ntype: application\nversion: 1.0.0\nappVersion: "1"\n`
    return gzipSync(tar([['kubeez-agent/Chart.yaml', chart], ['kubeez-agent/templates/kubeez.yaml', manifest]]))
}

/** The connect script: run where kubectl works for the cluster. */
export function connectScript(s, baseUrl, shell = 'sh') {
    const access = `${baseUrl}/api/import/${s.code}/access.yaml`
    const post = `${baseUrl}/api/import/${s.code}/credentials`
    if (shell === 'ps1') return `# KubeEZ — connect the cluster of your current kubectl context to "${s.name}" (${s.level === 'full' ? 'Full manage' : 'Read-only'})
$ErrorActionPreference = 'Stop'
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl is needed (and must reach the cluster)' }
$ctx = kubectl config current-context
Write-Host "Connecting the cluster of context '$ctx' to KubeEZ..."
kubectl get nodes -o name | Out-Null
kubectl apply -f "${access}"
$token = ''
for ($i = 0; $i -lt 30 -and -not $token; $i++) { $token = kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.token}' 2>$null; if (-not $token) { Start-Sleep 2 } }
if (-not $token) { throw 'The kubeez token was not created — is the token controller running?' }
$ca = kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}'
if (-not $ca) { $ca = kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.ca\\.crt}' }
$server = kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
$body = @{ server = $server; token = $token; ca = $ca; context = $ctx } | ConvertTo-Json -Compress
Write-Host 'Checking it from KubeEZ...'
try { $r = Invoke-RestMethod -Method Post -Uri "${post}" -ContentType 'application/json' -Body $body; Write-Host $r.message }
catch { $m = $_.ErrorDetails.Message; if ($m) { try { $m = ($m | ConvertFrom-Json).message } catch { } }; Write-Host "KubeEZ could not connect: $m"; exit 1 }
`
    return `#!/bin/sh
# KubeEZ — connect the cluster of your current kubectl context to "${s.name}" (${s.level === 'full' ? 'Full manage' : 'Read-only'})
set -e
command -v kubectl >/dev/null 2>&1 || { echo "kubectl is needed (and must reach the cluster)"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is needed"; exit 1; }
CTX=$(kubectl config current-context)
echo "Connecting the cluster of context '$CTX' to KubeEZ..."
kubectl get nodes -o name >/dev/null
kubectl apply -f "${access}"
TOKEN=""; i=0
while [ -z "$TOKEN" ] && [ $i -lt 30 ]; do TOKEN=$(kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.token}' 2>/dev/null || true); [ -z "$TOKEN" ] && sleep 2; i=$((i+1)); done
[ -n "$TOKEN" ] || { echo "The kubeez token was not created — is the token controller running?"; exit 1; }
CA=$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
[ -n "$CA" ] || CA=$(kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.ca\\.crt}')
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
echo "Checking it from KubeEZ..."
# KubeEZ answers in words (and why, when it cannot connect)
OUT=$(curl -sS -X POST -H 'content-type: application/json' "${post}?format=text" -w '\\n%{http_code}' \\
  -d "{\\"server\\":\\"$SERVER\\",\\"token\\":\\"$TOKEN\\",\\"ca\\":\\"$CA\\",\\"context\\":\\"$CTX\\"}") || { echo "Could not reach KubeEZ at ${post}"; exit 1; }
echo "$OUT" | sed '$d'
[ "$(echo "$OUT" | tail -n1)" = "200" ] || exit 1
`
}

// ── checking a cluster ──────────────────────────────────────────────────────
const PROBE = [
    `kubectl version -o json --request-timeout=15s 2>&1`,
    `echo '==NODES=='; kubectl get nodes -o json --request-timeout=20s 2>&1`,
    `echo '==GROUPS=='; kubectl api-versions --request-timeout=15s 2>/dev/null`,
    `echo '==CP=='; kubectl -n kube-system get pods -o name --request-timeout=15s 2>/dev/null`,
    `echo '==CANI=='; kubectl auth can-i create deployments --all-namespaces 2>/dev/null`,
    `echo '==END=='`
].join('; ')

/** What went wrong, in words a person can act on. */
export function explainFailure(text, { server, mode } = {}) {
    const t = String(text || '')
    if (/Unauthorized|401/.test(t)) return { error: 'The cluster refused the kubeez token (Unauthorized).', hint: 'Run the connect command again — it creates a fresh token.' }
    if (/forbidden/i.test(t)) return { error: 'The kubeez account may not read the cluster (Forbidden).', hint: 'Run the connect command again with an admin kubectl context — it sets the permissions.' }
    if (/x509|certificate/i.test(t)) return { error: 'The API server\'s certificate does not match the CA KubeEZ was given.', hint: 'Use the kubeconfig the provider gave you (its certificate-authority-data), or the KubeEZ agent method.' }
    if (/no such host|lookup .* on|server misbehaving/i.test(t)) return { error: `The API address ${server || ''} cannot be resolved from KubeEZ.`, hint: 'A private DNS name — use the KubeEZ agent method (or a Gateway Agent for on-prem).' }
    if (/i\/o timeout|connection refused|dial tcp|Unable to connect|context deadline|EHOSTUNREACH|ETIMEDOUT/i.test(t)) return { error: `KubeEZ cannot reach the API server${server ? ` at ${server}` : ''}${mode === 'gateway' ? ' through the Gateway Agent' : ''}.`, hint: mode === 'gateway' ? 'Check the Gateway Agent machine can reach that address (firewall, VPN).' : 'A private endpoint, a firewall or an IP allow-list — use the KubeEZ agent method, or allow KubeEZ\'s address on the API server.' }
    if (/not connected|not online|GATEWAY_OFFLINE|AGENT_OFFLINE/i.test(t)) return { error: t.split('\n')[0].slice(0, 200), hint: null }
    return { error: (t.trim().split('\n').filter(Boolean).pop() || 'The cluster did not answer').slice(0, 300), hint: null }
}

/** Ask the cluster who it is → { ok, version, detected, canWrite } or { ok: false, error, hint } */
export async function probe(target, { mode = 'direct', server = null } = {}) {
    const r = await runSandboxed(target, PROBE, { timeoutMs: 90000 })
    const sec = {}
    const parts = String(r.stdout).split(/^==([A-Z]+)==$/m)
    sec.VERSION = parts[0]
    for (let i = 1; i < parts.length; i += 2) sec[parts[i]] = (parts[i + 1] || '').trim()
    const json = (s) => { try { return JSON.parse(s) } catch { return null } }
    const nodes = json(sec.NODES)
    if (!nodes?.items) return { ok: false, ...explainFailure(`${sec.NODES || ''}\n${r.stderr}`, { server, mode }) }
    const v = json(sec.VERSION.slice(sec.VERSION.indexOf('{')))
    const version = v?.serverVersion?.gitVersion || null
    const detected = detectCluster(nodes, { version, apiGroups: (sec.GROUPS || '').split('\n').map(l => l.split('/')[0]).filter(Boolean), cpPods: (sec.CP || '').split('\n').map(l => l.replace(/^pod\//, '')) })
    return { ok: true, version: (version || '').replace(/^v/, '') || detected.version, detected, canWrite: /^yes/.test(sec.CANI || '') }
}

// the routes worth trying for a server, best first
async function routesFor(s, server) {
    const host = (() => { try { return new URL(server).hostname.replace(/^\[|\]$/g, '') } catch { return '' } })()
    if (!host || !/^https:\/\//.test(server)) throw bad('The API address must be an https:// URL')
    const saas = process.env.KUBEEZ_MODE === 'saas'
    let isPrivate = false
    try {
        const net = await import('net'); const dns = await import('dns')
        const addrs = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true })).map(a => a.address)
        isPrivate = addrs.some(isPrivateAddress)
    } catch { isPrivate = false }
    const { agentService } = await import('./agentService.js')
    const gw = await agentService.getGatewayAgentForOwner(s.ownerId, 'admin', s.orgId)
    const direct = !(saas && isPrivate)   // KubeEZ Cloud never connects to private addresses itself
    if (s.method === 'direct') { if (!direct) throw bad(`${host} is a private address — KubeEZ Cloud reaches it only through a Gateway Agent or the KubeEZ agent.`, { code: 'PRIVATE_ADDRESS' }); return [{ mode: 'direct' }] }
    if (s.method === 'gateway') { if (!gw) throw bad('No Gateway Agent of this workspace is online — start one (Gateway Agents page), or use the KubeEZ agent method.', { code: 'GATEWAY_OFFLINE' }); return [{ mode: 'gateway', gatewayAgentId: gw.agentId }] }
    const out = []
    if (direct && !(isPrivate && gw)) out.push({ mode: 'direct' })
    if (gw) out.push({ mode: 'gateway', gatewayAgentId: gw.agentId })
    if (direct && isPrivate && gw) out.push({ mode: 'direct' })
    if (!out.length) throw bad(`${host} is a private address and no Gateway Agent is online — use the KubeEZ agent method (one kubectl apply), or start a Gateway Agent in that network.`, { code: 'PRIVATE_ADDRESS' })
    return out
}

const tempCluster = (s, access) => ({ id: `probe-${s.code}`, ownerId: s.ownerId, orgId: s.orgId, access })

/** The connect script sent the cluster's address, CA and kubeez token. */
export async function receiveCredentials(code, body = {}) {
    const s = getSession(code)
    if (!s) throw Object.assign(new Error('This connect command has expired — open "Add existing cluster" again for a new one.'), { status: 404 })
    if (s.status === 'connected') return { message: `Already connected to KubeEZ as "${s.name}".`, clusterId: s.clusterId }
    const server = String(body.server || '').trim()
    const b64 = (v) => String(v || '').trim()
    let token = b64(body.token)
    // the Secret's token arrives base64-encoded
    if (token && !/^ey/.test(token)) { try { const d = Buffer.from(token, 'base64').toString('utf8'); if (/^ey[\w-]+\.[\w-]+\.[\w-]*$/.test(d)) token = d } catch { } }
    if (!/^ey[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) throw bad('The kubeez token is missing or not a token')
    const ca = b64(body.ca)
    if (ca && !/^[A-Za-z0-9+/=]+$/.test(ca)) throw bad('The CA must be base64 (certificate-authority-data)')
    update(code, { status: 'checking', error: null, hint: null, context: String(body.context || '').slice(0, 200) })
    return connectWith(s, { server, token, ca })
}

/** Try each route; save the cluster on the first that works. */
async function connectWith(s, { server, token, ca }) {
    let routes
    try { routes = await routesFor(s, server) }
    catch (e) { update(s.code, { status: 'failed', error: e.message, hint: e.code === 'PRIVATE_ADDRESS' || e.code === 'GATEWAY_OFFLINE' ? 'Use the KubeEZ agent method.' : null }); throw e }
    let last = null
    for (const route of routes) {
        const access = { mode: route.mode, server, ca: ca || null, token: encrypt(token), ...(route.gatewayAgentId ? { gatewayAgentId: route.gatewayAgentId } : {}) }
        const temp = tempCluster(s, access)
        let p
        try { p = await probe(await apiTarget(temp), { mode: route.mode, server }) }
        catch (e) { p = { ok: false, ...explainFailure(e.message, { server, mode: route.mode }) } }
        finally { closeForwarders(temp.id) }
        if (p.ok) return finishImport(s, { ...access, gatewayAgentId: route.gatewayAgentId || null }, p)
        last = p
    }
    update(s.code, { status: 'failed', error: last.error, hint: last.hint })
    throw Object.assign(new Error(last.error), { status: 422, hint: last.hint })
}

/** The KubeEZ agent inside the cluster said hello (first time: the import finishes). */
export async function onClusterHello(agent, msg) {
    const token = String(msg.token || '')
    if (!/^ey[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) return
    const ca = /^[A-Za-z0-9+/=]+$/.test(String(msg.ca || '')) ? String(msg.ca) : null
    const { clusterStore } = await import('./clusterStore.js')
    const existing = (await clusterStore.getClusters()).find(c => c.id === agent.clusterId)
    const access = { mode: 'agent', server: 'https://kubernetes.default.svc', ca, token: encrypt(token), agentId: agent.agentId }
    if (existing) {
        // a reconnect / a rotated token: keep the rest
        if (existing.orgId !== agent.orgId) return
        const same = (() => { try { return decrypt(existing.access?.token) === token } catch { return false } })()
        // a new token, another route, or a NEW agent (Reconnect → kubectl apply / helm upgrade) takes over
        if (!same || existing.access?.mode !== 'agent' || existing.access?.agentId !== agent.agentId) {
            closeForwarders(existing.id)
            const now = new Date().toISOString()
            // the session's access level when this agent came from a Reconnect / Full manage command
            const s = Object.values(load()).find(x => x.agentId === agent.agentId)
            await clusterStore.saveCluster({ ...existing, access: { ...existing.access, ...access, level: s?.level || existing.access?.level || 'read', lastOk: now, lastError: null, checkedAt: now } })
            if (s) update(s.code, { status: 'connected', route: 'agent' })
        }
        return
    }
    const s = Object.values(load()).find(x => x.agentId === agent.agentId)
    if (!s) return
    update(s.code, { status: 'checking', error: null })
    const temp = tempCluster(s, access)
    let p
    try { p = await probe(await apiTarget({ ...temp, access: { ...access } }), { mode: 'agent' }) }
    catch (e) { p = { ok: false, ...explainFailure(e.message, { mode: 'agent' }) } }
    finally { closeForwarders(temp.id) }
    if (!p.ok) { update(s.code, { status: 'failed', error: p.error, hint: p.hint }); return }
    await finishImport(s, access, p)
}

async function finishImport(s, access, p) {
    const { clusterStore } = await import('./clusterStore.js')
    const { installationManager } = await import('./installationManager.js')
    const all = await clusterStore.getClusters()
    const prev = all.find(c => c.id === s.clusterId)
    if (prev && prev.orgId !== s.orgId) throw Object.assign(new Error('Not your cluster'), { status: 403 })
    // the plan's limits (a reconnect adds nothing)
    if (!prev) {
        const { licenseService } = await import('./licenseService.js')
        const lim = await licenseService.checkEnforcementLimit(s.ownerId, 'admin', 1, p.detected.nodeCount, s.orgId)
        if (!lim.allowed) { update(s.code, { status: 'failed', error: lim.error, hint: 'Remove a cluster or upgrade the plan, then run the command again.' }); throw Object.assign(new Error(lim.error), { status: 402 }) }
    }
    const level = s.level === 'full' && !p.canWrite ? 'read' : s.level
    const now = new Date().toISOString()
    const cluster = {
        ...(prev || {}),
        id: s.clusterId, clusterName: prev?.clusterName || s.name, orgId: s.orgId, ownerId: prev?.ownerId || s.ownerId,
        status: 'healthy', imported: true, importedAt: prev?.importedAt || now,
        k8sVersion: p.version, provider: p.detected.provider !== 'unknown' ? p.detected.provider : s.provider, distro: p.detected.distro,
        nodeCount: p.detected.nodeCount, importedNodes: p.detected.nodes,
        masterNodes: prev?.masterNodes || [], workerNodes: prev?.workerNodes || [],
        ...(s.labels && !prev ? { labels: s.labels } : {}),
        access: { ...access, level, connectedAt: prev?.access?.connectedAt || now, lastOk: now, lastError: null, checkedAt: now }
    }
    closeForwarders(cluster.id)
    await clusterStore.saveCluster(cluster)
    installationManager.invalidateClusterCache?.()
    update(s.code, { status: 'connected', route: access.mode, detected: { provider: cluster.provider, distro: cluster.distro, version: cluster.k8sVersion, nodes: cluster.nodeCount }, ...(level !== s.level ? { hint: 'Connected read-only: the kubeez account may not change things. Run the command again from an admin context for Full manage.' } : {}) })
    // watched from now on (incidents, alerts)
    try { const { incidentDetector } = await import('./incidentDetector.js'); incidentDetector.watchCluster(cluster) } catch { }
    const { auditLog } = await import('./auditLog.js')
    auditLog.record({ orgId: s.orgId, actor: { id: s.ownerId, username: s.ownerUsername }, action: prev ? 'cluster.reconnected' : 'cluster.imported', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${providerById(cluster.provider)?.name || cluster.provider} · ${cluster.distro} · Kubernetes ${cluster.k8sVersion} · ${cluster.nodeCount} node(s) · ${access.mode} · ${level === 'full' ? 'Full manage' : 'Read-only'}` })
    return { message: `Connected to KubeEZ as "${cluster.clusterName}" — ${cluster.nodeCount} node(s), Kubernetes ${cluster.k8sVersion}${level !== s.level ? ' (read-only: the account may not change things)' : ''}.`, clusterId: cluster.id }
}

// ── a pasted kubeconfig ─────────────────────────────────────────────────────
/** → { server, ca, user: { token } | { cert, key } } or throws with what to do instead */
export function readKubeconfig(text) {
    let kc
    try { kc = parseYaml(String(text || '')) } catch (e) { throw bad(`This is not a kubeconfig (${e.message.split('\n')[0]})`) }
    if (!kc?.clusters?.length) throw bad('This is not a kubeconfig (no clusters in it)')
    const ctxName = kc['current-context'] || kc.contexts?.[0]?.name
    const ctx = (kc.contexts || []).find(c => c.name === ctxName)?.context || {}
    const cl = ((kc.clusters || []).find(c => c.name === ctx.cluster) || kc.clusters[0]).cluster || {}
    const us = ((kc.users || []).find(u => u.name === ctx.user) || kc.users?.[0] || {}).user || {}
    if (!cl.server) throw bad('The kubeconfig has no server address')
    if (cl['certificate-authority'] && !cl['certificate-authority-data']) throw bad('The kubeconfig points to a CA file on your machine — run: kubectl config view --raw --minify --flatten, and paste that instead.')
    if (us.exec || us['auth-provider']) {
        const cmd = us.exec?.command || us['auth-provider']?.name || 'a login plugin'
        throw bad(`This kubeconfig logs in through ${cmd} on your machine, which KubeEZ cannot run. Use the connect command instead (it runs where ${cmd} works).`, { code: 'EXEC_PLUGIN' })
    }
    if (us['client-certificate'] && !us['client-certificate-data']) throw bad('The kubeconfig points to certificate files on your machine — run: kubectl config view --raw --minify --flatten, and paste that instead.')
    const user = us.token ? { token: us.token } : us['client-certificate-data'] && us['client-key-data'] ? { cert: us['client-certificate-data'], key: us['client-key-data'] } : null
    if (!user) throw bad('The kubeconfig has no usable login (a token or a client certificate)')
    return { server: cl.server, ca: cl['certificate-authority-data'] || null, insecure: !!cl['insecure-skip-tls-verify'], tlsServerName: cl['tls-server-name'] || null, user, context: ctxName || null }
}

/**
 * A pasted kubeconfig: used ONCE (its admin login creates the `kubeez` account),
 * then thrown away — only the kubeez token is kept.
 */
export async function importKubeconfig(code, text) {
    const s = getSession(code)
    if (!s) throw Object.assign(new Error('This session has expired — start again.'), { status: 404 })
    const kc = readKubeconfig(text)
    if (kc.insecure) throw bad('The kubeconfig turns certificate checks off (insecure-skip-tls-verify) — KubeEZ needs the cluster\'s CA (certificate-authority-data).')
    update(code, { status: 'checking', error: null, hint: null })
    let routes
    try { routes = await routesFor(s, kc.server) }
    catch (e) { update(code, { status: 'failed', error: e.message, hint: 'Use the KubeEZ agent method.' }); throw e }
    const boot = `set -e
printf '%s' "$KZ_MANIFEST" | base64 -d | kubectl apply -f - >/dev/null
for i in $(seq 1 30); do T=$(kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.token}' 2>/dev/null || true); [ -n "$T" ] && break; sleep 2; done
[ -n "$T" ] || { echo "the kubeez token was not created" >&2; exit 1; }
echo "TOKEN=$T"
echo "CA=$(kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.ca\\.crt}')"`
    let last = null
    for (const route of routes) {
        const tmp = tempCluster(s, { mode: route.mode, server: kc.server, ca: kc.ca, token: encrypt('x'), ...(route.gatewayAgentId ? { gatewayAgentId: route.gatewayAgentId } : {}) })
        try {
            // the route's address, with the pasted login (token or client certificate)
            const t = await apiTarget(tmp)
            const target = { ...t, token: kc.user.token || null, clientCert: kc.user.cert || null, clientKey: kc.user.key || null, tlsServerName: t.tlsServerName || kc.tlsServerName || null }
            const r = await runSandboxed(target, `KZ_MANIFEST='${Buffer.from(accessManifest(s.level)).toString('base64')}'\n${boot}`, { timeoutMs: 120000 })
            const tok = /^TOKEN=(\S+)/m.exec(r.stdout)?.[1]
            if (r.code !== 0 || !tok) { last = explainFailure(`${r.stderr}\n${r.stdout}`, { server: kc.server, mode: route.mode }); continue }
            const ca = kc.ca || /^CA=(\S+)/m.exec(r.stdout)?.[1] || null
            closeForwarders(tmp.id)
            // from here on, only the kubeez token — the pasted login is not kept
            return await connectWith({ ...s, method: route.mode }, { server: kc.server, token: Buffer.from(tok, 'base64').toString('utf8'), ca })
        } catch (e) { last = { error: e.message, hint: e.hint || null } }
        finally { closeForwarders(tmp.id) }
    }
    update(code, { status: 'failed', error: last?.error, hint: last?.hint })
    throw Object.assign(new Error(last?.error || 'Could not connect'), { status: 422, hint: last?.hint })
}

// ── a connected cluster ─────────────────────────────────────────────────────
/** Is it still reachable? Updates the record (nodes, version, last error). */
export async function checkConnection(cluster) {
    const { clusterStore } = await import('./clusterStore.js')
    if (!usesApi(cluster)) return null
    let p
    try { p = await probe(await apiTarget(cluster), { mode: cluster.access.mode, server: cluster.access.server }) }
    catch (e) { p = { ok: false, ...explainFailure(e.message, { mode: cluster.access.mode, server: cluster.access.server }) } }
    const now = new Date().toISOString()
    const fresh = (await clusterStore.getClusters()).find(c => c.id === cluster.id)
    if (!fresh) return null
    const access = { ...fresh.access, checkedAt: now, ...(p.ok ? { lastOk: now, lastError: null, lastHint: null } : { lastError: p.error, lastHint: p.hint || null }) }
    await clusterStore.saveCluster({ ...fresh, access, ...(p.ok ? { k8sVersion: p.version, nodeCount: p.detected.nodeCount, importedNodes: p.detected.nodes, distro: p.detected.distro } : {}) })
    return { ok: p.ok, error: p.error || null, hint: p.hint || null, checkedAt: now }
}

/** Read-only ↔ Full: going down KubeEZ does itself; going up needs the user's admin (a command). */
export async function lowerToRead(cluster) {
    const r = await runSandboxed(await apiTarget(cluster), `kubectl delete clusterrolebinding kubeez-full --ignore-not-found --request-timeout=20s`, { timeoutMs: 60000 })
    if (r.code !== 0) throw Object.assign(new Error(explainFailure(r.stderr).error), { status: 502 })
}

/** A new token (Full manage only: the read-only account cannot touch Secrets). */
export async function rotateToken(cluster) {
    const r = await runSandboxed(await apiTarget(cluster), `set -e
kubectl -n ${NS} delete secret kubeez-token --request-timeout=20s >/dev/null
printf '%s' "$KZ_SECRET" | base64 -d | kubectl apply -f - >/dev/null
for i in $(seq 1 30); do T=$(kubectl -n ${NS} get secret kubeez-token -o jsonpath='{.data.token}' 2>/dev/null || true); [ -n "$T" ] && break; sleep 2; done
echo "TOKEN=$T"`.replace('"$KZ_SECRET"', `'${Buffer.from(`apiVersion: v1\nkind: Secret\nmetadata:\n  name: kubeez-token\n  namespace: ${NS}\n  labels: { app.kubernetes.io/managed-by: kubeez }\n  annotations: { kubernetes.io/service-account.name: kubeez }\ntype: kubernetes.io/service-account-token\n`).toString('base64')}'`), { timeoutMs: 120000 })
    const tok = /^TOKEN=(\S+)/m.exec(r.stdout)?.[1]
    if (!tok) throw Object.assign(new Error(explainFailure(r.stderr || 'no token').error), { status: 502 })
    return Buffer.from(tok, 'base64').toString('utf8')
}

/** Remove what KubeEZ put in the cluster (Full manage only). */
export async function cleanupCluster(cluster) {
    const r = await runSandboxed(await apiTarget(cluster), `kubectl delete clusterrolebinding kubeez-read kubeez-view kubeez-full --ignore-not-found --request-timeout=20s; kubectl delete clusterrole kubeez-read --ignore-not-found --request-timeout=20s; kubectl delete namespace ${NS} --ignore-not-found --wait=false --request-timeout=20s`, { timeoutMs: 90000 })
    return r.code === 0
}

// ── SSH for an on-prem imported cluster ─────────────────────────────────────
// Each node is checked before it is kept: SSH works, and its hostname is a node
// of THIS cluster. A kubeadm cluster (admin.conf on its control-planes) then
// works like one KubeEZ installed (etcd snapshots, upgrades, new nodes); any
// other distribution keeps the Kubernetes API for everything and uses SSH only
// for node shells and node checks.
const HOST = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
export async function addSsh(cluster, input, user) {
    const net = await import('net')
    const nodes = (Array.isArray(input) ? input : []).slice(0, 100)
    if (!nodes.length) throw bad('Add at least one node')
    for (const n of nodes) {
        if (!(net.isIP(String(n.ip || '')) || HOST.test(String(n.ip || '')))) throw bad(`"${String(n.ip || '').slice(0, 60)}" is not an IP address or hostname`)
        if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(String(n.username || ''))) throw bad(`Invalid SSH user for ${n.ip}`)
        if (!n.password && !n.sshKey) throw bad(`A password or an SSH key for ${n.ip}`)
    }
    const { automationEngine } = await import('./automationEngine.js')
    const known = (cluster.importedNodes || []).map(n => ({ ...n, lname: String(n.name || '').toLowerCase() }))
    const checked = []
    for (const n of nodes) {
        let ssh
        try { ssh = await automationEngine.connectSSH({ ip: n.ip, port: n.port || 22, username: n.username, password: n.password || undefined, sshKey: n.sshKey || undefined, ownerId: cluster.ownerId, orgId: cluster.orgId }) }
        catch (e) { throw Object.assign(new Error(`${n.ip}: SSH failed — ${e.message}`), { status: 422 }) }
        try {
            const r = await ssh.execCommand(`hostname; (sudo -n test -f /etc/kubernetes/admin.conf && echo KUBEADM) 2>/dev/null; true`)
            // (through a Gateway Agent a failed login shows here, as a command that did not run)
            if (r.code !== 0 || !String(r.stdout || '').trim()) throw Object.assign(new Error(`${n.ip}: the SSH login failed — ${String(r.stderr || 'no answer').trim().split('\n').pop().slice(0, 200)}`), { status: 422 })
            const [host, ...rest] = String(r.stdout || '').trim().split('\n')
            const h = String(host || '').trim().toLowerCase()
            const match = known.find(k => k.lname === h || k.lname.split('.')[0] === h.split('.')[0] || k.ip === n.ip)
            if (!match) throw Object.assign(new Error(`${n.ip} (${host || '?'}) is not a node of ${cluster.clusterName} — its nodes are ${known.map(k => k.name).slice(0, 8).join(', ')}`), { status: 422 })
            checked.push({ ip: n.ip, port: n.port || 22, username: n.username, ...(n.password ? { password: n.password } : {}), ...(n.sshKey ? { sshKey: n.sshKey } : {}), hostname: match.name, role: match.role, kubeadm: rest.includes('KUBEADM') })
        } finally { ssh.dispose?.() }
    }
    const cps = checked.filter(n => n.role === 'control-plane')
    const kubeadm = cluster.distro === 'kubeadm' && cps.length > 0 && cps.every(n => n.kubeadm)
    const strip = ({ kubeadm: _k, role: _r, ...n }) => n
    const { clusterStore } = await import('./clusterStore.js')
    const next = kubeadm
        // like a cluster KubeEZ installed: SSH for everything (first: a control-plane)
        ? { ...cluster, masterNodes: cps.map(strip), workerNodes: checked.filter(n => n.role !== 'control-plane').map(strip), sshNodes: [] }
        : { ...cluster, sshNodes: checked.map(n => ({ ...strip(n), role: n.role })) }
    closeForwarders(cluster.id)
    await clusterStore.saveCluster(next)
    const { auditLog } = await import('./auditLog.js')
    auditLog.record({ orgId: cluster.orgId, actor: user, action: 'cluster.ssh_added', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${checked.map(n => `${n.hostname} (${n.ip})`).join(', ')} — ${kubeadm ? 'kubeadm: etcd snapshots, upgrades and new nodes over SSH' : 'node shells and node checks over SSH'}` })
    return { nodes: checked.map(n => ({ ip: n.ip, hostname: n.hostname, role: n.role })), mode: kubeadm ? 'kubeadm' : 'nodes-only' }
}

/** Forget the SSH logins: back to the Kubernetes API for everything. */
export async function removeSsh(cluster, user) {
    const { clusterStore } = await import('./clusterStore.js')
    await clusterStore.saveCluster({ ...cluster, masterNodes: [], workerNodes: [], sshNodes: [] })
    closeForwarders(cluster.id)
    const { auditLog } = await import('./auditLog.js')
    auditLog.record({ orgId: cluster.orgId, actor: user, action: 'cluster.ssh_removed', target: { clusterId: cluster.id, clusterName: cluster.clusterName } })
}

let timer = null
/** Every 5 minutes: is each imported cluster still reachable? */
export function startConnectionChecks({ everyMs = 5 * 60e3 } = {}) {
    if (timer || process.env.NODE_ENV === 'test') return
    timer = setInterval(async () => {
        const { clusterStore } = await import('./clusterStore.js')
        for (const c of (await clusterStore.getClusters().catch(() => [])).filter(usesApi)) {
            try { await checkConnection(c) } catch (e) { console.error('[Import] check failed', c.id, e.message) }
        }
    }, everyMs)
    timer.unref?.()
}

export const _test = { reset: () => { sessions = {}; persist() }, update }
