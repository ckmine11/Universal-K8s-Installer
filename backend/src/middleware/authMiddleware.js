import { authService } from '../services/authService.js';
import { canOn } from '../services/accessControl.js';
import { clusterStore } from '../services/clusterStore.js';
import { canAccessResource } from '../utils/access.js';

export const requireAuth = (req, res, next) => {
    let token;

    // Cookie first (HttpOnly — most secure)
    if (req.cookies?.token) {
        token = req.cookies.token;
    }
    // Authorization header (API clients / backward compat)
    else {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
        // Query param (file downloads only)
        else if (req.query?.token) {
            token = req.query.token;
        }
    }

    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = authService.verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

    req.user = decoded;
    next();
};

export const requireSuperAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Super Admin access required' });
    }
    next();
};

// The cluster a request is about: set by a route (incidents → their cluster),
// or named in the address, the body or the query. Only a cluster of the
// member's own workspace counts.
async function clusterOf(req) {
    const ids = [req.permissionClusterId, req.params?.clusterId, req.params?.id, req.body?.clusterId, req.query?.clusterId, req.query?.cluster]
        .filter(v => typeof v === 'string' && v)
    if (!ids.length) return null
    const clusters = await clusterStore.getClusters().catch(() => [])
    for (const id of ids) {
        const c = clusters.find(x => x.id === id)
        if (c && canAccessResource(req.user, c)) return c
    }
    return null
}

/**
 * RBAC gate: allow the request only if the member may do `permission` — on
 * the cluster the request is about (custom roles and cluster rules apply
 * there), otherwise workspace-wide. `permission` may be a function of the
 * request. Must run after requireAuth. Returns 403 with a clear message.
 */
export const requirePermission = (permission) => async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const perm = typeof permission === 'function' ? permission(req) : permission;
    let cluster = null;
    try { cluster = await clusterOf(req); } catch { }
    if (!canOn(req.user, perm, cluster)) {
        return res.status(403).json({
            error: cluster
                ? `You do not have permission for this on ${cluster.clusterName || 'this cluster'}.`
                : `Your role does not have permission to perform this action.`,
            requiredPermission: perm
        });
    }
    req.permissionCluster = cluster;
    next();
};
