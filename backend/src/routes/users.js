import express from 'express'
import { authService } from '../services/authService.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { ROLES, PERMISSION_GROUPS, PERMISSIONS, permissionsForRole } from '../config/permissions.js'
import bcrypt from 'bcryptjs'
import { passwordProblem } from '../utils/passwordPolicy.js'
import { memberAddedEmail, sendAccountEmailLater } from '../utils/accountEmails.js'

const router = express.Router()

const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer']

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
    res.json({
        myRole: req.user.role,
        myPermissions: permissionsForRole(req.user.role),
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
            return res.status(401).json({ error: 'Current password is incorrect' })
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
        if (role && !ASSIGNABLE_ROLES.includes(role)) {
            return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
        }

        const newUser = await authService.createTeamMember(req.user.orgId, username, password, email, role || 'viewer')
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
        if (!ASSIGNABLE_ROLES.includes(role)) {
            return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
        }

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
        authService.saveUsers()

        res.json({
            success: true,
            message: `Role updated to ${role}`,
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

export default router
