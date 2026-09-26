import express from 'express'
import { authService } from '../services/authService.js'
import { requireAuth } from '../middleware/authMiddleware.js'
import { ROLES, PERMISSION_GROUPS, PERMISSIONS, permissionsForRole } from '../config/permissions.js'
import bcrypt from 'bcryptjs'

const router = express.Router()

const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer']

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
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' })
        }

        // Load all users to find this one
        const users = authService.users
        const userIdx = users.findIndex(u => u.id === req.user.id)
        if (userIdx < 0) return res.status(404).json({ error: 'User not found' })

        // Verify current password
        const isMatch = await bcrypt.compare(currentPassword, users[userIdx].password)
        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect' })
        }

        // Hash new password
        const hashed = await bcrypt.hash(newPassword, 10)
        authService.users[userIdx].password = hashed
        authService.saveUsers()

        res.json({ success: true, message: 'Password changed successfully' })
    } catch (err) {
        console.error('Password change error:', err)
        res.status(500).json({ error: err.message })
    }
})

// ─── Admin: List team members ─────────────────────────────────────
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const users = authService.getUsersByOrgId(req.user.orgId).map(u => ({
            id: u.id,
            username: u.username,
            email: u.email,
            role: u.role,
            createdAt: u.createdAt
        }))
        // Seat usage so the UI can show "3 / 5 seats used"
        const orgAdmin = authService.users.find(u => u.orgId === req.user.orgId && u.role === 'admin')
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
        if (role && !ASSIGNABLE_ROLES.includes(role)) {
            return res.status(400).json({ error: `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}` })
        }

        const newUser = await authService.createTeamMember(req.user.orgId, username, password, email, role || 'viewer')
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
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' })
        }

        const userIdx = authService.users.findIndex(u => u.id === req.params.id && u.orgId === req.user.orgId)
        if (userIdx < 0) return res.status(404).json({ error: 'User not found in your organization' })

        const hashed = await bcrypt.hash(newPassword, 10)
        authService.users[userIdx].password = hashed
        authService.saveUsers()

        res.json({ success: true, message: `Password reset for user "${authService.users[userIdx].username}"` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

export default router
