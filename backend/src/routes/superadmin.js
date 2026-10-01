import express from 'express';
import { authService } from '../services/authService.js';
import { installationManager } from '../services/installationManager.js';
import { incidentDetector } from '../services/incidentDetector.js';
import { requireAuth, requireSuperAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Apply super admin security to all routes in this file
router.use(requireAuth, requireSuperAdmin);

// Normalize an Enterprise billing amount to a monthly figure
function monthlyFromBilling(billing) {
    if (!billing || !billing.amount) return 0;
    const amt = parseFloat(billing.amount) || 0;
    return billing.cycle === 'annual' ? amt / 12 : amt;
}

// ─── Super Admin: Platform-wide overview stats ───────────────────────────────
router.get('/stats', async (req, res) => {
    try {
        const users = authService.getAllUsers();

        // Tenant & plan breakdown (team members share an org — count owners as tenants)
        const planCounts = { FREE: 0, PRO: 0, ENTERPRISE: 0 };
        let mrr = 0;
        let teamMembers = 0;
        for (const u of users) {
            const plan = String(u.subscription?.plan || 'FREE').toUpperCase();
            if (plan === 'MEMBER') { teamMembers++; continue; }
            if (plan === 'PRO') { planCounts.PRO++; mrr += 49; }
            else if (plan === 'ENTERPRISE') { planCounts.ENTERPRISE++; mrr += monthlyFromBilling(u.subscription?.billing); }
            else { planCounts.FREE++; }
        }

        const orgOwners = users.filter(u => u.role === 'admin' || u.role === 'superadmin').length;
        const suspended = users.filter(u => u.isSuspended).length;

        // Cluster stats across ALL tenants
        let clusters = [];
        try { clusters = await installationManager.getSavedClusters(); } catch { clusters = []; }
        const clusterStatus = {};
        let totalNodes = 0;
        for (const c of clusters) {
            const s = c.status || 'unknown';
            clusterStatus[s] = (clusterStatus[s] || 0) + 1;
            totalNodes += (c.nodes?.length || c.masterNodes?.length || 0) + (c.workerNodes?.length || 0);
        }

        // Incident stats
        const incidents = incidentDetector.getIncidents() || [];
        const unresolvedIncidents = incidents.filter(i => !i.resolved).length;

        res.json({
            tenants: { total: users.length, owners: orgOwners, teamMembers, suspended },
            plans: planCounts,
            revenue: { mrr: Math.round(mrr), arr: Math.round(mrr * 12), currency: 'USD' },
            clusters: { total: clusters.length, byStatus: clusterStatus, totalNodes },
            incidents: { total: incidents.length, unresolved: unresolvedIncidents },
            generatedAt: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Super Admin: All clusters across every tenant ───────────────────────────
router.get('/clusters', async (req, res) => {
    try {
        const clusters = await installationManager.getSavedClusters();
        const users = authService.getAllUsers();
        const byId = Object.fromEntries(users.map(u => [u.id, u]));
        const byOrg = {};
        users.forEach(u => { if ((u.role === 'admin' || u.role === 'superadmin') && u.orgId) byOrg[u.orgId] = u; });

        const enriched = clusters.map(c => {
            const owner = byId[c.ownerId] || byOrg[c.orgId];
            return {
                id: c.id,
                clusterName: c.clusterName,
                status: c.status,
                k8sVersion: c.k8sVersion,
                nodeCount: (c.nodes?.length || c.masterNodes?.length || 0) + (c.workerNodes?.length || 0),
                createdAt: c.createdAt,
                ownerId: c.ownerId,
                orgId: c.orgId,
                ownerName: owner?.username || 'Unknown',
                ownerEmail: owner?.email || '',
                ownerPlan: owner?.subscription?.plan || 'FREE'
            };
        });
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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
        const { plan, maxClusters, maxNodes, maxMembers, billing } = req.body;
        if (!plan) {
            return res.status(400).json({ error: 'Plan name is required' });
        }

        const updatedUser = authService.updateUserSubscription(
            req.params.id,
            plan,
            parseInt(maxClusters) || 0,
            parseInt(maxNodes) || 0,
            maxMembers,  // optional — service picks a sensible per-plan default if omitted
            billing      // optional — Enterprise billing record { amount, cycle, currency, paymentLink, notes }
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
        // Only real roles from config/permissions.js ('user' grants nothing)
        const VALID_ROLES = ['superadmin', 'admin', 'operator', 'viewer'];
        if (!VALID_ROLES.includes(role)) {
            return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
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

// ─── Super Admin: Delete a tenant/user ────────────────────────────────────────
router.delete('/users/:id', (req, res) => {
    try {
        if (req.params.id === req.user.id) {
            return res.status(400).json({ error: 'You cannot delete your own superadmin account' });
        }
        const removed = authService.deleteUser(req.params.id);
        res.json({ success: true, message: `Deleted user ${removed.username}`, user: removed });
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

export default router;
