import express from 'express';
import { authService } from '../services/authService.js';
import { requireAuth, requireSuperAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Apply super admin security to all routes in this file
router.use(requireAuth, requireSuperAdmin);

// ─── Super Admin: List all tenants/users ─────────────────────────────────────
router.get('/users', (req, res) => {
    try {
        const users = authService.getAllUsers();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Super Admin: Update user limits/subscription ──────────────────────────────────────
router.put('/users/:id/limits', (req, res) => {
    try {
        const { plan, maxClusters, maxNodes } = req.body;
        if (!plan) {
            return res.status(400).json({ error: 'Plan name is required' });
        }
        
        const updatedUser = authService.updateUserSubscription(
            req.params.id, 
            plan, 
            parseInt(maxClusters) || 0, 
            parseInt(maxNodes) || 0
        );
        res.json({ success: true, message: 'Limits updated successfully', user: updatedUser });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ─── Super Admin: Suspend or Activate user ────────────────────────────────────────
router.put('/users/:id/status', (req, res) => {
    try {
        const { isSuspended } = req.body;
        if (typeof isSuspended !== 'boolean') {
            return res.status(400).json({ error: 'isSuspended must be a boolean' });
        }
        
        // Prevent superadmin from suspending themselves
        if (req.params.id === req.user.id) {
            return res.status(400).json({ error: 'Cannot suspend your own superadmin account' });
        }

        const updatedUser = authService.updateUserStatus(req.params.id, isSuspended);
        res.json({ success: true, message: isSuspended ? 'Account suspended' : 'Account activated', user: updatedUser });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ─── Super Admin: Change user role ────────────────────────────────────────
router.put('/users/:id/role', (req, res) => {
    try {
        const { role } = req.body;
        if (!['admin', 'superadmin', 'user'].includes(role)) {
            return res.status(400).json({ error: 'Role must be admin, superadmin, or user' });
        }

        // Prevent superadmin from demoting themselves
        if (req.params.id === req.user.id && role !== 'superadmin') {
            return res.status(400).json({ error: 'Cannot demote your own superadmin account' });
        }

        const updatedUser = authService.updateUserRole(req.params.id, role);
        res.json({ success: true, message: 'Role updated successfully', user: updatedUser });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

export default router;
