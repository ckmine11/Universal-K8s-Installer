import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for API endpoints
 * Prevents abuse by limiting requests per IP address
 */
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // The UI polls several endpoints (incidents, active installs, health), so a
    // single active user makes many requests. 2000/15min per IP is generous for
    // real usage while still stopping abuse. Per-IP works because trust proxy is on.
    max: 2000,
    message: {
        success: false,
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    // Skip lightweight, high-frequency polling + health endpoints
    // (the full path: mounted at /api/, req.path would be "/health" and never match)
    // AI answers being written are polled a few times a second while they stream
    skip: (req) => {
        const p = String(req.originalUrl || '').split('?')[0]
        return p === '/api/health' || p === '/api/incidents' || p === '/api/clusters/installations/active' || p.startsWith('/api/ai/jobs/')
    }
});

/**
 * Stricter rate limiter for authentication endpoints
 * Prevents brute force attacks
 */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15, // Limit each IP to 15 auth attempts per 15 minutes
    message: {
        success: false,
        error: 'Too many login attempts, please try again later.',
        retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true // Don't count successful requests
});

/**
 * Rate limiter for cluster operations
 * Prevents overwhelming the system with too many installations
 */
export const clusterOperationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // Limit each IP to 20 cluster operations per hour
    message: {
        success: false,
        error: 'Too many cluster operations, please try again later.',
        retryAfter: '1 hour'
    },
    standardHeaders: true,
    legacyHeaders: false
});
