/**
 * Request logging middleware
 * Logs all incoming requests with timestamp, method, path, and response time
 */
export function requestLogger(req, res, next) {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    // Log request
    console.log(`[${timestamp}] ${req.method} ${req.path}`);

    // Log request body for POST/PUT (excluding sensitive data)
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const sanitizedBody = sanitizeBody(req.body);
        if (Object.keys(sanitizedBody).length > 0) {
            console.log(`  Body:`, JSON.stringify(sanitizedBody, null, 2));
        }
    }

    // Capture response
    const originalSend = res.send;
    res.send = function (data) {
        const duration = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
        originalSend.call(this, data);
    };

    next();
}

/**
 * Sanitize request body to remove sensitive information from logs
 */
function sanitizeBody(body) {
    if (!body || typeof body !== 'object') {
        return {};
    }

    const sensitiveFields = ['password', 'sshPassword', 'sshKey', 'token', 'secret'];
    const sanitized = { ...body };

    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }

    // Recursively sanitize nested objects
    for (const key in sanitized) {
        if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
            if (Array.isArray(sanitized[key])) {
                sanitized[key] = sanitized[key].map(item =>
                    typeof item === 'object' ? sanitizeBody(item) : item
                );
            } else {
                sanitized[key] = sanitizeBody(sanitized[key]);
            }
        }
    }

    return sanitized;
}

/**
 * Error logging middleware
 * Logs all errors that occur during request processing
 */
export function errorLogger(err, req, res, next) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ERROR in ${req.method} ${req.path}:`);
    console.error(err.stack || err.message || err);

    // Pass error to next error handler
    next(err);
}
