import { authService } from '../services/authService.js';
import { can } from '../config/permissions.js';

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

/**
 * RBAC gate: allow the request only if the user's role has `permission`.
 * Must run after requireAuth. Returns 403 with a clear message otherwise.
 */
export const requirePermission = (permission) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!can(req.user.role, permission)) {
        return res.status(403).json({
            error: `Your role (${req.user.role}) does not have permission to perform this action.`,
            requiredPermission: permission
        });
    }
    next();
};
