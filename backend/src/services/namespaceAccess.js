// Namespace-level access, enforced by Kubernetes itself.
//
// A member whose cluster rule is limited to some namespaces gets no
// cluster-wide group in the Explorer ('kubeez:scoped' instead), and KubeEZ
// keeps RoleBindings in exactly the allowed namespaces:
//   subjects: the member's Explorer identity (User kubeez:<name>) and their
//             kubeconfig service account (kubeez-access/kubeez-<hash>)
//   roleRef:  the built-in ClusterRole view | edit | admin (their level)
// Members with a limited but cluster-wide level (view/edit) get a
// ClusterRoleBinding for their service account, so a downloaded kubeconfig
// is never more than the role allows. Everything KubeEZ creates carries the
// label kubeez.io/managed=access and is removed when it is no longer needed.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { accessOn, nsMatches } from './accessControl.js'
import { authService } from './authService.js'
import { installationManager } from './installationManager.js'
import { automationEngine } from './automationEngine.js'
import { connectCluster } from './clusterAccess.js'

const KB = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'
export const ACCESS_NS = 'kubeez-access'
const LABEL = 'kubeez.io/managed=access'
const ROLE_FOR = { view: 'view', edit: 'edit', admin: 'admin' }
const FILE = path.join(DATA_DIR, 'namespace-access.json')
const FRESH_MS = 5 * 60 * 1000

export const userHash = (userId) => crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12)
export const saName = (userId) => `kubeez-${userHash(userId)}`
// must be the user name the Explorer sends (explorerProxy.identityFor)
export const explorerUser = (u) => `kubeez:${String(u.username || u.id || '').replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 100)}`

const status = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } })()
const saveStatus = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(status, null, 2)) } catch { } }

/** Who needs what on this cluster (pure — tested without a cluster). */
export function desiredState(cluster, members, namespaces) {
    const roleBindings = [], saBindings = [], serviceAccounts = []
    for (const m of members) {
        if (m.role === 'admin' || m.role === 'superadmin') continue
        const a = accessOn(m, cluster)
        if (!a.permissions.has('cluster:view') || a.kube === 'none') continue
        const sa = saName(m.id)
        const subjects = [
            { kind: 'User', name: explorerUser(m), apiGroup: 'rbac.authorization.k8s.io' },
            { kind: 'ServiceAccount', name: sa, namespace: ACCESS_NS }
        ]
        if (a.namespaces?.length) {
            for (const ns of namespaces.filter(n => nsMatches(a.namespaces, n) && n !== ACCESS_NS)) {
                roleBindings.push({ ns, name: `kubeez-${userHash(m.id)}`, role: ROLE_FOR[a.kube] || 'view', subjects, user: m.username })
            }
            serviceAccounts.push({ name: sa, user: m.username })
        } else if (a.kube !== 'admin') {
            // cluster-wide but limited: the Explorer identity already gets its group;
            // the kubeconfig service account needs the same level
            saBindings.push({ name: `kubeez-sa-${userHash(m.id)}`, role: ROLE_FOR[a.kube] || 'view', sa, user: m.username })
            serviceAccounts.push({ name: sa, user: m.username })
        }
    }
    return { roleBindings, saBindings, serviceAccounts }
}

const hashOf = (d) => crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 16)

function manifests(d) {
    const meta = (name, ns, user) => ({ name, ...(ns ? { namespace: ns } : {}), labels: { 'kubeez.io/managed': 'access', 'kubeez.io/user': String(user).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) } })
    const items = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ACCESS_NS, labels: { 'kubeez.io/managed': 'access' } } }]
    for (const s of d.serviceAccounts) items.push({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta(s.name, ACCESS_NS, s.user) })
    for (const b of d.roleBindings) items.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: meta(b.name, b.ns, b.user), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: b.role }, subjects: b.subjects })
    for (const b of d.saBindings) items.push({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: meta(b.name, null, b.user), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: b.role }, subjects: [{ kind: 'ServiceAccount', name: b.sa, namespace: ACCESS_NS }] })
    return { apiVersion: 'v1', kind: 'List', items }
}

async function withSSH(cluster, fn) {
    // SSH to the control-plane, or the Kubernetes API for an imported cluster
    const ssh = await connectCluster(cluster)
    try { return await fn(ssh) } finally { ssh.dispose?.() }
}
const run = async (ssh, cmd) => {
    const r = await ssh.execCommand(cmd)
    if (r.code && r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-2).join(' '))
    return (r.stdout || '').trim()
}

const inflight = new Map()

/** Bring the cluster's managed RBAC in line with the members' access. */
export async function syncCluster(clusterId, { force = false } = {}) {
    if (inflight.has(clusterId)) return inflight.get(clusterId)
    const p = (async () => {
        const cluster = (await installationManager.getSavedClusters()).find(c => c.id === clusterId)
        if (!cluster) return { skipped: 'gone' }
        const members = authService.getUsersByOrgId(cluster.orgId).map(u => ({ ...u, clusterAccess: u.clusterAccess || [] }))
        const st = status[clusterId] || {}
        // nothing to keep and nothing left behind → no need to touch the cluster
        const anyLimited = members.some(m => { const a = accessOn(m, cluster); return a.permissions.has('cluster:view') && a.kube !== 'none' && (a.namespaces?.length || (a.kube !== 'admin' && m.role !== 'admin' && m.role !== 'superadmin')) })
        if (!force && !anyLimited && !st.objects) return { skipped: 'nothing to do' }
        try {
            const result = await withSSH(cluster, async (ssh) => {
                const nss = (await run(ssh, `${KB} get ns -o jsonpath='{.items[*].metadata.name}'`)).split(/\s+/).filter(Boolean)
                const d = desiredState(cluster, members, nss)
                const h = hashOf(d)
                if (!force && st.hash === h && Date.now() - (st.at || 0) < FRESH_MS) return { unchanged: true, objects: st.objects }
                const want = new Set([
                    ...d.roleBindings.map(b => `rolebinding/${b.ns}/${b.name}`),
                    ...d.saBindings.map(b => `clusterrolebinding//${b.name}`),
                    ...d.serviceAccounts.map(s => `serviceaccount/${ACCESS_NS}/${s.name}`)
                ])
                const total = d.roleBindings.length + d.saBindings.length + d.serviceAccounts.length
                if (total) {
                    const b64 = Buffer.from(JSON.stringify(manifests(d))).toString('base64')
                    await run(ssh, `echo ${b64} | base64 -d | ${KB} apply -f - >/dev/null`)
                }
                // remove what KubeEZ created earlier and no longer needs
                const have = (await run(ssh, `{ ${KB} get rolebinding -A -l ${LABEL} -o jsonpath='{range .items[*]}rolebinding/{.metadata.namespace}/{.metadata.name}{"\\n"}{end}' 2>/dev/null; ${KB} get clusterrolebinding -l ${LABEL} -o jsonpath='{range .items[*]}clusterrolebinding//{.metadata.name}{"\\n"}{end}' 2>/dev/null; ${KB} -n ${ACCESS_NS} get serviceaccount -l ${LABEL} -o jsonpath='{range .items[*]}serviceaccount/${ACCESS_NS}/{.metadata.name}{"\\n"}{end}' 2>/dev/null; } || true`)).split('\n').filter(Boolean)
                const stale = have.filter(x => !want.has(x))
                for (const x of stale) {
                    const [kind, ns, name] = x.split('/')
                    if (!/^[a-z0-9.-]+$/.test(name) || (ns && !/^[a-z0-9-]+$/.test(ns))) continue
                    await run(ssh, `${KB} delete ${kind} ${name} ${ns ? `-n ${ns}` : ''} --ignore-not-found >/dev/null`)
                }
                return { objects: total, removed: stale.length, hash: h }
            })
            status[clusterId] = { at: Date.now(), hash: result.hash || st.hash, objects: result.objects ?? st.objects ?? 0, error: null }
            saveStatus()
            return result
        } catch (e) {
            status[clusterId] = { ...st, at: Date.now(), error: e.message }
            saveStatus()
            throw e
        }
    })().finally(() => inflight.delete(clusterId))
    inflight.set(clusterId, p)
    return p
}

/** After an access change: sync the workspace's clusters in the background. */
const timers = new Map()
export function scheduleOrg(orgId) {
    if (!orgId) return
    clearTimeout(timers.get(orgId))
    const t = setTimeout(async () => {
        timers.delete(orgId)
        const clusters = (await installationManager.getSavedClusters().catch(() => [])).filter(c => c.orgId === orgId)
        for (const c of clusters) syncCluster(c.id).catch(e => console.warn(`[access] ${c.clusterName}: ${e.message}`))
    }, 1500)
    t.unref?.()
    timers.set(orgId, t)
}

/** Before the Explorer serves a namespace-limited member: bindings must exist. */
export async function ensureFresh(clusterId) {
    const st = status[clusterId]
    if (st && !st.error && Date.now() - st.at < FRESH_MS) return
    await syncCluster(clusterId)
}

export const syncStatus = (clusterId) => status[clusterId] || null

/**
 * A kubeconfig limited to what the member may do: their service account's
 * token (24 h) instead of the cluster admin certificate.
 */
export async function scopedKubeconfig(cluster, member, adminKubeconfig) {
    const a = accessOn(member, cluster)
    await syncCluster(cluster.id, { force: true })
    const server = (adminKubeconfig.match(/server:\s*(\S+)/) || [])[1]
    const ca = (adminKubeconfig.match(/certificate-authority-data:\s*(\S+)/) || [])[1]
    if (!server || !ca) throw new Error('Could not read the cluster address from its admin kubeconfig')
    const token = await withSSH(cluster, (ssh) => run(ssh, `${KB} -n ${ACCESS_NS} create token ${saName(member.id)} --duration=24h`))
    if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error('Kubernetes returned no token')
    const name = String(cluster.clusterName || cluster.id).replace(/[^A-Za-z0-9._-]/g, '-')
    const firstNs = (a.namespaces || []).find(n => !n.endsWith('*'))
    return [
        'apiVersion: v1', 'kind: Config',
        `# KubeEZ: ${member.username} on ${cluster.clusterName} — ${a.kube}${a.namespaces?.length ? ` in ${a.namespaces.join(', ')}` : ' (cluster-wide)'}. Valid 24 hours.`,
        'clusters:', `- name: ${name}`, '  cluster:', `    server: ${server}`, `    certificate-authority-data: ${ca}`,
        'users:', `- name: ${member.username}`, '  user:', `    token: ${token}`,
        'contexts:', `- name: ${member.username}@${name}`, '  context:', `    cluster: ${name}`, `    user: ${member.username}`, ...(firstNs ? [`    namespace: ${firstNs}`] : []),
        `current-context: ${member.username}@${name}`, ''
    ].join('\n')
}
