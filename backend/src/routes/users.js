import express from 'express'
import { authService } from '../services/authService.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { ROLES, PERMISSION_GROUPS, PERMISSIONS, permissionsForRole, CLUSTER_PERMISSIONS, ADMIN_ONLY_PERMISSIONS, KUBE_LEVELS, BUILTIN_KUBE_LEVEL, ROLE_TEMPLATES, AI_ACCESS } from '../config/permissions.js'
import { auditLog } from '../services/auditLog.js'
import { roleStore, customRoleKey, customRoleId } from '../services/roleStore.js'
import { accessOn, accessSummary, describeRole, cleanClusterRules, canSeeCluster } from '../services/accessControl.js'
import { clusterStore } from '../services/clusterStore.js'
import { isPaidPlan } from '../config/planFeatures.js'
import { scheduleOrg } from '../services/namespaceAccess.js'
import bcrypt from 'bcryptjs'
import { passwordProblem } from '../utils/passwordPolicy.js'
import { memberAddedEmail, sendAccountEmailLater } from '../utils/accountEmails.js'

const router = express.Router()

const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer']
// a built-in role, or a custom role of this workspace
const validRole = (orgId, role) => ASSIGNABLE_ROLES.includes(role) || (!!customRoleId(role) && !!roleStore.get(orgId, customRoleId(role)))
// custom roles and cluster rules are part of the paid plans
const customRolesAllowed = (req) => req.user.role === 'superadmin' || isPaidPlan(authService.getOrgPlan(req.user.orgId))
const PLAN_ERROR = { error: 'Custom roles and per-cluster access are part of Pro. On Free, use Admin, Operator and Viewer.', upgrade: true }

// Accounts another admin may not demote, delete or reset: the workspace owner
// (holds the plan/billing) and the platform super admin. Returns an error or null.
function protectedTarget(actor, target) {
    if (target.id === actor.id) return null
    if (target.role === 'superadmin' && actor.role !== 'superadmin') return 'The platform super admin account cannot be changed from a workspace.'
    if (authService.getOrgOwner(target.orgId)?.id === target.id && actor.role !== 'superadmin') {
        return 'This is the workspace owner (holds the plan and billing) — only the owner can change this account.'
    }
    return null
}

// ─── Middleware: Admin only ───────────────────────────────────────
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Admin access required' })
    }
    next()
}

// ─── RBAC transparency: roles, permission matrix, and MY permissions ──
// Any authenticated user can see exactly who can do what.
router.get('/rbac', requireAuth, (req, res) => {
    const custom = req.user.orgId ? roleStore.list(req.user.orgId) : []
    res.json({
        myRole: req.user.role,
        myPermissions: [...accessOn(req.user).permissions],
        customRoles: custom.map(r => ({ key: customRoleKey(r.id), name: r.name, description: r.description, permissions: r.permissions, kube: r.kube })),
        roles: Object.values(ROLES),
        matrix: PERMISSION_GROUPS.map(g => ({
            group: g.group,
            items: g.items.map(item => ({
                key: item.key,
                label: item.label,
                roles: ASSIGNABLE_ROLES.filter(r => (PERMISSIONS[item.key] || []).includes(r))
            }))
        }))
    })
})

// ─── Password Change (any logged-in user) ────────────────────────
router.post('/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' })
        }
        const pwProblem = passwordProblem(newPassword)
        if (pwProblem) return res.status(400).json({ error: pwProblem })

        // Load all users to find this one
        const users = authService.users
        const userIdx = users.findIndex(u => u.id === req.user.id)
        if (userIdx < 0) return res.status(404).json({ error: 'User not found' })

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, users[userIdx].password)
        if (!isMatch) {
            // 400, not 401: a 401 makes the app log the person out instead of showing the message
            return res.status(400).json({ error: 'Current password is incorrect' })
        }

        // Other sessions are logged out; this one gets a fresh token
        await authService.setPassword(users[userIdx], newPassword)
        const token = authService.generateToken(users[userIdx])
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        })
        res.json({ success: true, message: 'Password changed — other sessions were logged out', token })
    } catch (err) {
        console.error('Password change error:', err)
        res.status(500).json({ error: err.message })
    }
})

// ─── Admin: List team members ─────────────────────────────────────
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const ownerId = authService.getOrgOwner(req.user.orgId)?.id
        const users = authService.getUsersByOrgId(req.user.orgId).map(u => ({
            id: u.id,
            username: u.username,
            email: u.email,
            role: u.role,
            roleName: describeRole(u.orgId, u.role).name,
            roleMissing: !!describeRole(u.orgId, u.role).missing,
            clusterAccess: Array.isArray(u.clusterAccess) ? u.clusterAccess : [],
            // KubeEZ AI: given by an admin, or part of the role (custom roles)
            aiAccess: u.aiAccess || 'none',
            ai: (() => { const p = accessOn({ ...u, clusterAccess: [] }).permissions; return p.has('ai:apply') ? 'apply' : p.has('ai:use') ? 'ask' : 'none' })(),
            isOwner: u.id === ownerId,   // holds the plan — other admins cannot change this account
            createdAt: u.createdAt
        }))
        // Seat usage so the UI can show "3 / 5 seats used"
        const orgAdmin = authService.getOrgOwner(req.user.orgId)
        const maxMembers = orgAdmin?.subscription?.maxMembers ?? 1
        res.json({ users, seats: { used: users.length, max: maxMembers } })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// ─── Admin: Create Team Member ────────────────────────────────────
router.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { username, password, email, role } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required' })
        const problem = passwordProblem(password) ||
            (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username) ? 'Username must be 3-32 characters: letters, numbers, ".", "-" and "_"' : null)
        if (problem) return res.status(400).json({ error: problem })
        if (role && !validRole(req.user.orgId, role)) {
            return res.status(400).json({ error: `Role must be Admin, Operator, Viewer or one of your custom roles` })
        }
        if (customRoleId(role) && !customRolesAllowed(req)) return res.status(402).json(PLAN_ERROR)

        const ai = req.body?.aiAccess || 'none'
        if (!AI_ACCESS[ai]) return res.status(400).json({ error: 'AI access: none, ask or apply' })
        const newUser = await authService.createTeamMember(req.user.orgId, username, password, email, role || 'viewer')
        // KubeEZ AI chosen while inviting (admins always have it)
        if (ai !== 'none' && newUser.role !== 'admin') { const u = authService.users.find(x => x.id === newUser.id); if (u) { u.aiAccess = ai; authService.saveUsers() } }
        // Tell the new member (never the password — the admin hands that over)
        sendAccountEmailLater(newUser.email, memberAddedEmail(newUser, { addedBy: req.user.username, role: newUser.role }), 'team-invite')
        res.json({ success: true, message: 'Team member created', user: { id: newUser.id, username: newUser.username, role: newUser.role } })
    } catch (err) {
        res.status(400).json({ error: err.message })
    }
})

// ─── Admin: Change user role ──────────────────────────────────────
router.put('/admin/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { role } = req.body
        if (!validRole(req.user.orgId, role)) {
            return res.status(400).json({ error: `Role must be Admin, Operator, Viewer or one of your custom roles` })
        }
        if (customRoleId(role) && !customRolesAllowed(req)) return res.status(402).json(PLAN_ERROR)

        const targetId = req.params.id

        // Cannot demote yourself out of admin (prevents locking yourself out)
        if (targetId === req.user.id && role !== 'admin') {
            return res.status(400).json({ error: 'You cannot change your own admin role — ask another admin.' })
        }

        const userIdx = authService.users.findIndex(u => u.id === targetId && u.orgId === req.user.orgId)
        if (userIdx < 0) return res.status(404).json({ error: 'User not found in your organization' })
        const blocked = protectedTarget(req.user, authService.users[userIdx])
        if (blocked) return res.status(403).json({ error: blocked })

        authService.users[userIdx].role = role
        // admins have full access everywhere — cluster rules would only confuse
        if (role === 'admin') { delete authService.users[userIdx].clusterAccess; delete authService.users[userIdx].aiAccess }
        authService.saveUsers()
        scheduleOrg(req.user.orgId)

        res.json({
            success: true,
            message: `Role updated to ${describeRole(req.user.orgId, role).name}`,
            user: {
                id: authService.users[userIdx].id,
                username: authService.users[userIdx].username,
                role: authService.users[userIdx].role
            }
        })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// ─── Admin: Delete user ───────────────────────────────────────────
router.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const targetId = req.params.id

        // Cannot delete yourself
        if (targetId === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' })
        }

        const userIdx = authService.users.findIndex(u => u.id === targetId && u.orgId === req.user.orgId)
        if (userIdx < 0) return res.status(404).json({ error: 'User not found in your organization' })

        const blocked = protectedTarget(req.user, authService.users[userIdx])
        if (blocked) return res.status(403).json({ error: blocked })

        const deletedUsername = authService.users[userIdx].username
        authService.users.splice(userIdx, 1)
        authService.saveUsers()
        scheduleOrg(req.user.orgId)   // their RoleBindings / service account are removed
        res.json({ success: true, message: `User "${deletedUsername}" has been deleted` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// ─── Admin: Reset user password ───────────────────────────────────
router.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { newPassword } = req.body
        const pwProblem = passwordProblem(newPassword)
        if (pwProblem) return res.status(400).json({ error: pwProblem })

        const userIdx = authService.users.findIndex(u => u.id === req.params.id && u.orgId === req.user.orgId)
        if (userIdx < 0) return res.status(404).json({ error: 'User not found in your organization' })

        const blocked = protectedTarget(req.user, authService.users[userIdx])
        if (blocked) return res.status(403).json({ error: blocked })

        // Their existing sessions end; they log in with the new password
        await authService.setPassword(authService.users[userIdx], newPassword)
        res.json({ success: true, message: `Password reset for user "${authService.users[userIdx].username}" — their sessions were logged out` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

// ─── Custom roles & per-cluster access ─────────────────────────────
const roleView = (orgId, r) => {
    const members = authService.getUsersByOrgId(orgId)
    const key = customRoleKey(r.id)
    return {
        ...r, key,
        members: members.filter(u => u.role === key).map(u => u.username),
        inClusterRules: members.filter(u => (u.clusterAccess || []).some(x => x.role === key)).map(u => u.username)
    }
}

// Everything the role builder needs
router.get('/roles', requireAuth, requireAdmin, (req, res) => {
    const orgId = req.user.orgId
    const members = authService.getUsersByOrgId(orgId)
    res.json({
        allowed: customRolesAllowed(req),
        builtin: ASSIGNABLE_ROLES.map(k => ({
            key: k, name: ROLES[k].label, description: ROLES[k].description, builtin: true,
            permissions: permissionsForRole(k), kube: BUILTIN_KUBE_LEVEL[k],
            members: members.filter(u => u.role === k).map(u => u.username)
        })),
        custom: roleStore.list(orgId).map(r => roleView(orgId, r)),
        templates: ROLE_TEMPLATES,
        groups: PERMISSION_GROUPS.map(g => ({
            group: g.group,
            items: g.items.map(it => ({ ...it, perCluster: CLUSTER_PERMISSIONS.includes(it.key), adminOnly: ADMIN_ONLY_PERMISSIONS.includes(it.key) }))
        })),
        kubeLevels: KUBE_LEVELS
    })
})

router.post('/roles', requireAuth, requireAdmin, (req, res) => {
    if (!customRolesAllowed(req)) return res.status(402).json(PLAN_ERROR)
    try { res.json(roleView(req.user.orgId, roleStore.create(req.user.orgId, req.body, req.user.username))) }
    catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

router.put('/roles/:id', requireAuth, requireAdmin, (req, res) => {
    if (!customRolesAllowed(req)) return res.status(402).json(PLAN_ERROR)
    try { const out = roleView(req.user.orgId, roleStore.update(req.user.orgId, req.params.id, req.body, req.user.username)); scheduleOrg(req.user.orgId); res.json(out) }
    catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// A role that someone still has cannot be deleted — move them first
router.delete('/roles/:id', requireAuth, requireAdmin, (req, res) => {
    const role = roleStore.get(req.user.orgId, req.params.id)
    if (!role) return res.status(404).json({ error: 'Role not found' })
    const v = roleView(req.user.orgId, role)
    const using = [...new Set([...v.members, ...v.inClusterRules])]
    if (using.length) return res.status(409).json({ error: `Still used by ${using.join(', ')} — give them another role first.`, members: using })
    roleStore.remove(req.user.orgId, req.params.id)
    res.json({ success: true, message: `Role "${role.name}" deleted` })
})

// A member's cluster rules: a different role on some clusters (or no access)
router.put('/admin/users/:id/cluster-access', requireAuth, requireAdmin, async (req, res) => {
    try {
        const target = authService.users.find(u => u.id === req.params.id && u.orgId === req.user.orgId)
        if (!target) return res.status(404).json({ error: 'User not found in your organization' })
        const blocked = protectedTarget(req.user, target)
        if (blocked) return res.status(403).json({ error: blocked })
        if (target.role === 'admin') return res.status(400).json({ error: 'Admins have full access to every cluster — change the role first to limit it.' })
        const rules = req.body?.rules || []
        if (rules.length && !customRolesAllowed(req)) return res.status(402).json(PLAN_ERROR)
        const clusters = (await clusterStore.getClusters()).filter(c => c.orgId === req.user.orgId)
        target.clusterAccess = cleanClusterRules(req.user.orgId, rules, clusters.map(c => c.id))
        if (!target.clusterAccess.length) delete target.clusterAccess
        authService.saveUsers()
        scheduleOrg(req.user.orgId)   // namespace limits → Kubernetes RBAC
        res.json({ success: true, clusterAccess: target.clusterAccess || [] })
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// A member's KubeEZ AI access: none | ask (Ask AI, explanations, Create YAML) | apply (also apply what the AI wrote)
router.put('/admin/users/:id/ai-access', requireAuth, requireAdmin, (req, res) => {
    const target = authService.users.find(u => u.id === req.params.id && u.orgId === req.user.orgId)
    if (!target) return res.status(404).json({ error: 'User not found in your organization' })
    const level = req.body?.aiAccess
    if (!AI_ACCESS[level]) return res.status(400).json({ error: 'AI access: none, ask or apply' })
    if (target.role === 'admin' || target.role === 'superadmin') return res.status(400).json({ error: 'Admins always have KubeEZ AI.' })
    const before = target.aiAccess || 'none'
    if (level === 'none') delete target.aiAccess
    else target.aiAccess = level
    authService.saveUsers()
    if (before !== level) auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'team.ai_access', detail: `${target.username}: ${AI_ACCESS[before]?.label || before} → ${AI_ACCESS[level].label}` })
    res.json({ success: true, aiAccess: level, message: `${target.username}: ${AI_ACCESS[level].label}` })
})

// What I may do — workspace-wide and on each of my clusters (for the UI)
router.get('/rbac/me', requireAuth, async (req, res) => {
    const clusters = (await clusterStore.getClusters().catch(() => [])).filter(c => req.user.role === 'superadmin' || c.orgId === req.user.orgId)
    res.json(accessSummary(req.user, clusters))
})

// Access review: who can do what, on which cluster (for audits — ISO 27001 A.5.18)
router.get('/admin/access-review', requireAuth, requireAdmin, async (req, res) => {
    const orgId = req.user.orgId
    const clusters = (await clusterStore.getClusters()).filter(c => c.orgId === orgId)
    const rows = []
    for (const u of authService.getUsersByOrgId(orgId)) {
        const member = { ...u, clusterAccess: u.clusterAccess || [] }
        const main = describeRole(orgId, u.role)
        const ws = accessOn(member).permissions
        if (!clusters.length) rows.push({ member: u.username, email: u.email || '', mainRole: main.name, cluster: '—', access: main.name, via: 'main role', kube: main.kube, ai: ws.has('ai:apply') ? 'ask & apply' : ws.has('ai:use') ? 'ask' : 'none', namespaces: 'all', temporaryUntil: '', permissions: [...ws].join(' ') })
        for (const c of clusters) {
            const a = accessOn(member, c)
            const seen = canSeeCluster(member, c)
            rows.push({
                member: u.username, email: u.email || '', mainRole: main.name, cluster: c.clusterName || c.id,
                access: seen ? a.role || main.name : 'No access',
                via: a.via === 'admin' ? 'admin' : a.via === 'cluster' ? 'cluster rule' : a.via === 'label' ? 'label rule' : a.via === 'elevation' ? 'temporary access' : 'main role',
                kube: seen ? a.kube : 'none',
                ai: a.permissions.has('ai:apply') ? 'ask & apply' : a.permissions.has('ai:use') ? 'ask' : 'none',
                namespaces: seen ? (a.namespaces?.join(' ') || 'all') : '',
                temporaryUntil: a.elevatedUntil || '',
                permissions: seen ? [...a.permissions].filter(p => CLUSTER_PERMISSIONS.includes(p)).join(' ') : ''
            })
        }
    }
    if (req.query.format === 'csv') {
        // a cell starting with = + - @ is shown as text, never run as a spreadsheet formula
        const esc = (v) => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
        const head = ['member', 'email', 'mainRole', 'cluster', 'access', 'via', 'kube', 'ai', 'namespaces', 'temporaryUntil', 'permissions']
        const csv = [head.join(','), ...rows.map(r => head.map(h => esc(r[h])).join(','))].join('\n')
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="kubeez-access-review-${new Date().toISOString().slice(0, 10)}.csv"`)
        return res.send(csv)
    }
    res.json({ generatedAt: new Date().toISOString(), rows })
})

export default router
