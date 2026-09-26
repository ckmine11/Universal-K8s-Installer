import { authService } from '../services/authService.js';

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
