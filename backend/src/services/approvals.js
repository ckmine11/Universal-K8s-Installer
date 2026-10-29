// Two-person approval and temporary elevation.
//
// Two-person approval: the workspace chooses which dangerous actions need a
// second person. Such a request is answered 428 until someone else with
// access:approve approved exactly that request (same member, action, cluster
// and body); the approval is used once and is valid for an hour.
//
// Temporary elevation: a member asks for a role on a cluster for some minutes,
// with a reason; once approved, the role is added on that cluster until it
// ends (accessControl.js) — then it is gone by itself.
import crypto from 'crypto'
import { approvalStore } from './approvalStore.js'
import { accessOn, canOn, canSeeCluster, describeRole, isBuiltinRole } from './accessControl.js'
import { customRoleId, roleStore } from './roleStore.js'
import { authService } from './authService.js'
import { auditLog } from './auditLog.js'
import { scheduleOrg } from './namespaceAccess.js'
import { deliveryStore } from './deliveryStore.js'

// the actions that can need a second person — and the route that does each
export const PROTECTED_ACTIONS = {
    'cluster:delete':  { label: 'Remove a cluster from KubeEZ', permission: 'cluster:delete', route: (id) => new RegExp(`^DELETE /api/clusters/${id}$`) },
    'cluster:upgrade': { label: 'Upgrade Kubernetes', permission: 'cluster:upgrade', route: (id) => new RegExp(`^POST /api/(clusters/${id}/upgrade|connect/clusters/${id}/cloud/upgrade|connect/clusters/${id}/cloud/pools/[^/]+/upgrade)$`) },
    'etcd:restore':    { label: 'Restore an etcd snapshot', permission: 'cluster:upgrade', route: (id) => new RegExp(`^POST /api/clusters/${id}/etcd/restore$`) },
    'etcd:recover':    { label: 'Rebuild a lost control-plane', permission: 'cluster:upgrade', route: (id) => new RegExp(`^POST /api/clusters/${id}/etcd/recover$`) },
    'addon:uninstall': { label: 'Uninstall or reinstall an add-on', permission: 'addon:install', route: (id) => new RegExp(`^POST /api/clusters/${id}/addons/[a-z0-9-]+/(uninstall|reinstall)$`) },
    'volume:restore':  { label: 'Restore volume backups', permission: 'cluster:upgrade', route: (id) => new RegExp(`^POST /api/clusters/${id}/volume-backups/restores$`) },
    'ai:action':       { label: 'Run a fix suggested by KubeEZ AI', permission: 'incident:act', route: (id) => new RegExp(`^POST /api/clusters/${id}/ai-actions$`) },
    'ai:apply':        { label: 'Apply YAML written by KubeEZ AI', permission: 'cluster:view', route: (id) => new RegExp(`^POST /api/clusters/${id}/ai-manifests$`) },
    'gitops:sync':     { label: 'Sync a GitOps app (Argo CD / Flux)', permission: 'gitops:sync', route: (id) => new RegExp(`^POST /api/clusters/${id}/gitops/sync$`) },
    // always asked for a protected environment, whatever the workspace setting
    'app:deploy':      { label: 'Install, upgrade or roll back a Helm app', permission: 'app:deploy', route: (id) => new RegExp(`^POST /api/clusters/${id}/apps(/[a-z0-9-]+/[a-z0-9-]+/rollback)?$`) },
    'app:uninstall':   { label: 'Uninstall a Helm app', permission: 'app:delete', route: (id) => new RegExp(`^DELETE /api/clusters/${id}/apps/[a-z0-9-]+/[a-z0-9-]+$`) },
    'hibernate':       { label: 'Hibernate a namespace (scale it to 0)', permission: 'hibernate:manage', route: (id) => new RegExp(`^POST /api/clusters/${id}/hibernate$`) },
    'debug:ephemeral': { label: 'Add a debug container to a running pod', permission: 'debug:ephemeral', route: (id) => new RegExp(`^POST /api/clusters/${id}/debug$`) },
    'rollout':         { label: 'Promote or retry a canary / blue-green rollout', permission: 'app:deploy', route: (id) => new RegExp(`^POST /api/clusters/${id}/rollouts/action$`) }
}
export const ELEVATION_MINUTES = [15, 30, 60, 120, 240, 480]
const bad = (m, status = 400) => Object.assign(new Error(m), { status })
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// the exact request: method, path and body (keys sorted; the approval itself left out)
const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v ?? null)
export const requestHash = (method, path, body) => crypto.createHash('sha256').update(`${method.toUpperCase()} ${path}\n${stable(body || {})}`).digest('hex')
const pathOf = (url) => String(url || '').split('?')[0]

function summaryOf(action, cluster, path, body) {
    const name = cluster?.clusterName || cluster?.id
    switch (action) {
        case 'cluster:upgrade': {
            const pool = path.match(/\/cloud\/pools\/([^/]+)\/upgrade$/)
            if (pool) return `Upgrade node pool ${decodeURIComponent(pool[1])} of ${name}${body?.targetVersion ? ` to Kubernetes ${body.targetVersion}` : ''}`
            return `Upgrade ${name} to Kubernetes ${body?.targetVersion || 'the next version'}`
        }
        case 'etcd:restore': return `Restore ${name} from ${body?.filename || 'a snapshot'}`
        case 'etcd:recover': return `Rebuild the control-plane of ${name}${body?.filename ? ` from ${body.filename}` : ''}`
        case 'addon:uninstall': { const m = path.match(/addons\/([a-z0-9-]+)\/(uninstall|reinstall)/); return `${m?.[2] === 'reinstall' ? 'Reinstall' : 'Uninstall'} ${m?.[1] || 'an add-on'} on ${name}` }
        case 'volume:restore': return `Restore volume backup ${body?.backup || body?.name || ''} on ${name} (${body?.mode || 'restore'})`.replace('  ', ' ')
        case 'cluster:delete': return `Remove ${name} from KubeEZ`
        case 'ai:apply': return `Apply YAML on ${name} in namespace ${body?.namespace || 'default'}${body?.description ? `: ${String(body.description).slice(0, 80)}` : ''}`
        case 'app:deploy': { const rb = path.match(/\/apps\/([a-z0-9-]+)\/([a-z0-9-]+)\/rollback$/); return rb ? `Roll back Helm app ${rb[1]}/${rb[2]} on ${name} to revision ${body?.revision}` : `Deploy Helm app ${body?.namespace || ''}/${body?.release || ''} (${body?.chart || 'chart'}${body?.version ? ` ${body.version}` : ''}) on ${name}` }
        case 'app:uninstall': { const m = path.match(/\/apps\/([a-z0-9-]+)\/([a-z0-9-]+)$/); return `Uninstall Helm app ${m?.[1]}/${m?.[2]} on ${name}` }
        case 'rollout': return `${body?.action === 'promote-full' ? 'Promote fully' : body?.action === 'retry' ? 'Retry' : 'Promote'} rollout ${body?.namespace || ''}/${body?.name || ''} on ${name}`
        case 'hibernate': return `Hibernate namespace ${body?.namespace || ''} on ${name} (scale its workloads to 0)`
        case 'debug:ephemeral': return `Add a ${body?.image || 'busybox'} debug container to ${body?.namespace || ''}/${body?.pod || ''} on ${name}`
        case 'gitops:sync': return `${body?.action === 'refresh' ? 'Refresh' : 'Sync'} GitOps app ${body?.kind || 'app'} ${body?.namespace || ''}/${body?.name || ''} on ${name}`
        case 'ai:action': { const sp = body?.spec || {}; return `KubeEZ AI fix on ${name}: ${sp.type || 'action'} ${sp.kind || ''} ${sp.namespace || 'default'}/${sp.name || ''}${sp.type === 'scale' ? ` to ${sp.replicas}` : ''}` }
        default: return `${PROTECTED_ACTIONS[action]?.label || action} on ${name}`
    }
}

/** Members who may approve (access:approve), excluding suspended accounts. */
export function approversOf(orgId) {
    return authService.getUsersByOrgId(orgId).filter(u => !u.isSuspended && canOn({ ...u, clusterAccess: u.clusterAccess || [] }, 'access:approve'))
}

const who = (u) => ({ id: u.id, username: u.username, role: u.role })

async function notify(r) {
    const { notifier } = await import('./notifier.js')
    notifier.emit(r.orgId, {
        type: 'approval_request', severity: 'warning', key: `approval|${r.id}`,
        title: r.kind === 'action' ? `Approval needed: ${r.summary}` : `Temporary access requested: ${r.requestedBy.username} → ${r.roleName} on ${r.clusterName}`,
        text: r.kind === 'action'
            ? `${r.requestedBy.username} wants to: ${r.summary}. Reason: "${r.reason}". A second admin must approve it in KubeEZ → Team & Roles → Approvals.`
            : `${r.requestedBy.username} asks for ${r.roleName} on ${r.clusterName} for ${r.minutes} minutes: "${r.reason}". Approve or deny in KubeEZ → Team & Roles → Approvals.`,
        clusterId: r.clusterId === '*' ? null : r.clusterId, clusterName: r.clusterName, link: '/users?tab=approvals'
    })
}

/**
 * Does this change hit a protected environment (it then always needs a second
 * person)? Helm app deploys, rollbacks and uninstalls into its namespace.
 */
export function protectedTarget(orgId, action, clusterId, path, body) {
    if (!['app:deploy', 'app:uninstall', 'hibernate', 'rollout'].includes(action)) return false
    const ns = /\/apps\/([a-z0-9-]+)\/[a-z0-9-]+(\/rollback)?$/.exec(path)?.[1] || body?.namespace
    return !!(ns && deliveryStore.environmentAt(orgId, clusterId, ns)?.protected)
}

/**
 * Middleware: this action may need a second person's approval. Runs after requirePermission.
 * always(req) → true asks for it even when the workspace has not turned it on (a protected environment).
 */
export const requireApproval = (action, { always = null } = {}) => async (req, res, next) => {
    try {
        if (!req.user?.orgId) return next()
        if (!approvalStore.settings(req.user.orgId).actions?.[action] && !(always && await always(req))) return next()
        const path = pathOf(req.originalUrl)
        const hash = requestHash(req.method, path, req.body)
        const id = req.get('x-kubeez-approval')
        if (id) {
            const r = approvalStore.get(id)
            const ok = r && r.kind === 'action' && r.orgId === req.user.orgId && r.action === action && r.requestedBy.id === req.user.id &&
                r.status === 'approved' && r.bodyHash === hash && Date.now() - new Date(r.decidedAt).getTime() < approvalStore.APPROVED_VALID_MS
            if (!ok) return res.status(403).json({ error: 'This approval does not match the request, was already used or has expired — ask again.', approvalRequired: true, action })
            approvalStore.update(id, { status: 'used', usedAt: new Date().toISOString() })
            auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'approval.used', target: { clusterId: r.clusterId, clusterName: r.clusterName }, detail: `${r.summary} — approved by ${r.decidedBy?.username}` })
            return next()
        }
        const clusterId = req.params.id
        const existing = approvalStore.list(req.user.orgId).find(r => r.kind === 'action' && r.requestedBy.id === req.user.id && r.bodyHash === hash && ['pending', 'approved'].includes(r.status))
        res.status(428).json({
            error: `${PROTECTED_ACTIONS[action].label} needs a second admin's approval in this workspace.`,
            approvalRequired: true, action, actionLabel: PROTECTED_ACTIONS[action].label, clusterId,
            summary: summaryOf(action, req.permissionCluster, path, req.body),
            existing: existing ? { id: existing.id, status: existing.status } : null
        })
    } catch (e) { next(e) }
}

/** A member asks: for an action (the exact request) or for a temporary role. */
export async function createRequest(user, input, clusters) {
    const reason = String(input?.reason || '').trim()
    if (reason.length < 5) throw bad('Say why (at least a few words) — the approver sees it, and it goes into the audit trail')
    const member = { ...authService.getUserById(user.id), clusterAccess: authService.getUserById(user.id)?.clusterAccess || [] }

    if (input?.kind === 'action') {
        const a = PROTECTED_ACTIONS[input.action]
        if (!a) throw bad('Unknown action')
        if (!approvalStore.settings(user.orgId).actions?.[input.action] && !protectedTarget(user.orgId, input.action, input.clusterId, String(input.path || ''), input.body)) throw bad('This action does not need an approval in your workspace — just run it')
        const cluster = clusters.find(c => c.id === input.clusterId)
        if (!cluster || !canSeeCluster(member, cluster)) throw bad('Cluster not found', 404)
        if (!canOn(member, a.permission, cluster)) throw bad('Your role may not do this on that cluster — an approval cannot add permissions', 403)
        const method = String(input.method || '').toUpperCase(), path = pathOf(input.path)
        if (!a.route(esc(cluster.id)).test(`${method} ${path}`)) throw bad('The request does not match the action')
        const hash = requestHash(method, path, input.body)
        const dup = approvalStore.list(user.orgId).find(r => r.kind === 'action' && r.requestedBy.id === user.id && r.bodyHash === hash && ['pending', 'approved'].includes(r.status))
        if (dup) return dup
        const r = approvalStore.add({ orgId: user.orgId, kind: 'action', action: input.action, clusterId: cluster.id, clusterName: cluster.clusterName, method, path, bodyHash: hash,
            summary: summaryOf(input.action, cluster, path, input.body), requestedBy: who(user), reason: reason.slice(0, 300) })
        auditLog.record({ orgId: user.orgId, actor: user, action: 'approval.requested', target: { clusterId: cluster.id, clusterName: cluster.clusterName }, detail: `${r.summary} — ${r.reason}` })
        notify(r).catch(() => { })
        return r
    }

    if (input?.kind === 'elevation') {
        const minutes = Number(input.minutes)
        if (!ELEVATION_MINUTES.includes(minutes)) throw bad(`Duration: ${ELEVATION_MINUTES.join(', ')} minutes`)
        const role = String(input.role || '')
        if (role === 'admin' || role === 'superadmin') throw bad('Temporary Admin is not possible — ask for Operator or a custom role')
        if (!(isBuiltinRole(role) || (customRoleId(role) && roleStore.get(user.orgId, customRoleId(role))))) throw bad('Unknown role')
        const cluster = input.clusterId === '*' ? null : clusters.find(c => c.id === input.clusterId)
        if (input.clusterId !== '*' && (!cluster || !canSeeCluster(member, cluster))) throw bad('Cluster not found', 404)
        if (user.role === 'admin' || user.role === 'superadmin') throw bad('Admins already have full access')
        const dup = approvalStore.list(user.orgId).find(r => r.kind === 'elevation' && r.requestedBy.id === user.id && r.clusterId === input.clusterId && ['pending', 'active'].includes(r.status))
        if (dup) throw bad(dup.status === 'active' ? 'You already have temporary access there — end it first to ask for another' : 'You already asked — wait for the answer or cancel that request')
        const r = approvalStore.add({ orgId: user.orgId, kind: 'elevation', clusterId: input.clusterId, clusterName: cluster ? cluster.clusterName : 'every cluster',
            role, roleName: describeRole(user.orgId, role).name, minutes, requestedBy: who(user), reason: reason.slice(0, 300) })
        auditLog.record({ orgId: user.orgId, actor: user, action: 'elevation.requested', target: cluster ? { clusterId: cluster.id, clusterName: cluster.clusterName } : null, detail: `${r.roleName} for ${minutes} min — ${r.reason}` })
        notify(r).catch(() => { })
        return r
    }
    throw bad('kind must be "action" or "elevation"')
}

export function decide(approver, id, approve, comment = '') {
    const r = approvalStore.get(id)
    if (!r || r.orgId !== approver.orgId) throw bad('Request not found', 404)
    if (r.status !== 'pending') throw bad(`This request is already ${r.status}`)
    const member = { ...approver, clusterAccess: authService.getUserById(approver.id)?.clusterAccess || [] }
    if (!canOn(member, 'access:approve')) throw bad('You may not approve requests', 403)
    if (r.requestedBy.id === approver.id) throw bad('Someone else has to approve your own request — that is the point of a second person', 403)
    const now = new Date()
    const patch = { decidedBy: who(approver), decidedAt: now.toISOString(), comment: String(comment || '').trim().slice(0, 300) }
    if (!approve) patch.status = 'denied'
    else if (r.kind === 'action') patch.status = 'approved'
    else { patch.status = 'active'; patch.until = new Date(now.getTime() + r.minutes * 60e3).toISOString() }
    const out = approvalStore.update(id, patch)
    auditLog.record({ orgId: r.orgId, actor: approver, action: approve ? (r.kind === 'action' ? 'approval.approved' : 'elevation.granted') : (r.kind === 'action' ? 'approval.denied' : 'elevation.denied'),
        target: r.clusterId && r.clusterId !== '*' ? { clusterId: r.clusterId, clusterName: r.clusterName } : null,
        detail: `${r.kind === 'action' ? r.summary : `${r.requestedBy.username}: ${r.roleName} for ${r.minutes} min`}${patch.comment ? ` — ${patch.comment}` : ''}` })
    if (r.kind === 'elevation') scheduleOrg(r.orgId)
    return out
}

export function cancel(user, id) {
    const r = approvalStore.get(id)
    if (!r || r.orgId !== user.orgId || r.requestedBy.id !== user.id) throw bad('Request not found', 404)
    if (r.status !== 'pending') throw bad(`This request is already ${r.status}`)
    return approvalStore.update(id, { status: 'cancelled', endedAt: new Date().toISOString() })
}

/** End a temporary role early — the holder or an approver. */
export function endElevation(user, id) {
    const r = approvalStore.get(id)
    if (!r || r.orgId !== user.orgId || r.kind !== 'elevation') throw bad('Request not found', 404)
    if (r.status !== 'active') throw bad('This temporary access is not active')
    const member = { ...user, clusterAccess: authService.getUserById(user.id)?.clusterAccess || [] }
    if (r.requestedBy.id !== user.id && !canOn(member, 'access:approve')) throw bad('Only the holder or an approver can end it', 403)
    const out = approvalStore.update(id, { status: 'ended', endedAt: new Date().toISOString(), endedBy: who(user) })
    auditLog.record({ orgId: r.orgId, actor: user, action: 'elevation.ended', target: r.clusterId !== '*' ? { clusterId: r.clusterId, clusterName: r.clusterName } : null, detail: `${r.requestedBy.username}: ${r.roleName}` })
    scheduleOrg(r.orgId)
    return out
}

// elevations that ran out: re-sync RBAC (namespace limits apply again) and note it
let sweeper = null
export function startApprovalSweeper() {
    if (sweeper) return
    sweeper = setInterval(() => {
        for (const r of approvalStore.sweep()) {
            if (r.kind === 'elevation' && r.endedAt) {
                auditLog.record({ orgId: r.orgId, actor: null, action: 'elevation.expired', target: r.clusterId !== '*' ? { clusterId: r.clusterId, clusterName: r.clusterName } : null, detail: `${r.requestedBy.username}: ${r.roleName}` })
                scheduleOrg(r.orgId)
            }
        }
    }, 60 * 1000)
    sweeper.unref?.()
}
