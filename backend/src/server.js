import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import path from 'path';
import { readFileSync } from 'fs'
import { passwordProblem } from './utils/passwordPolicy.js'
import { fileURLToPath } from 'url';
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import { v4 as uuidv4 } from 'uuid'
import installationRoutes from './routes/installation.js'
import nodeVerificationRoutes from './routes/nodeVerification.js'
import { installationManager } from './services/installationManager.js'
import { terminalService } from './services/terminalService.js'
import { healthRouter } from './routes/health.js'
import { apiLimiter, authLimiter } from './middleware/rateLimiter.js'
import { BackupService } from './services/backupService.js'
import licenseRoutes from './routes/license.js'
import agentRoutes from './routes/agent.js'
import usersRoutes from './routes/users.js'
import billingRoutes from './routes/billing.js'
import incidentsRoutes from './routes/incidents.js'
import stripeRoutes from './routes/stripe.js'
import { agentService } from './services/agentService.js'
import superadminRoutes from './routes/superadmin.js'
import offsiteRoutes from './routes/offsite.js'
import notificationsRoutes from './routes/notifications.js'
import { canAccessResource } from './utils/access.js'
import { clusterStore } from './services/clusterStore.js'
import { can } from './config/permissions.js'


const app = express()
// Trust the reverse proxy (nginx) so req.ip is the REAL client IP from
// X-Forwarded-For. Without this, every user shares one rate-limit bucket
// (the proxy's IP) and everyone gets throttled almost immediately.
// Value 1 = one proxy hop (nginx) directly in front of the backend.
app.set('trust proxy', 1)
const server = createServer(app)
// Browsers always send Origin on a WebSocket handshake. Accept only our own
// frontend origins (cross-site WebSocket hijacking); agents send no Origin.
const wss = new WebSocketServer({
    noServer: true,   // upgrades are routed below (Explorer WebSockets go to the cluster)
    verifyClient: ({ origin, req }) => {
        if (!origin) return true
        const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',').map(o => o.trim())
        const sameHost = (() => { try { return new URL(origin).host === req.headers.host } catch { return false } })()
        return allowed.includes(origin) || sameHost
    }
})

import { authService } from './services/authService.js'
import { mailConfigured } from './utils/mailer.js'
import { requireAuth } from './middleware/authMiddleware.js'
import { explorerHttp, explorerUpgrade, EXPLORER_PATH } from './services/explorerProxy.js'

// One HTTP 'upgrade' entry: KubeEZ Explorer WebSockets (pod terminal, log
// streams) are tunnelled to the cluster; everything else is KubeEZ's own.
server.on('upgrade', (req, socket, head) => {
    if (EXPLORER_PATH.test(req.url || '')) {
        const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000').split(',').map(o => o.trim())
        explorerUpgrade(req, socket, head, allowed).catch(() => { try { socket.destroy() } catch { } })
        return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

import { requestLogger, errorLogger } from './middleware/logger.js'

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP to avoid frontend conflicts (API-focused)
    crossOriginEmbedderPolicy: false
}))
// KubeEZ Explorer: streamed straight through (SSE, uploads) — before
// compression, the JSON body parser and the API rate limit (a Radar page
// loads dozens of assets). requireAuth + workspace check inside.
app.use(EXPLORER_PATH, cookieParser(), requireAuth, explorerHttp)

app.use(compression()) // Gzip compression

// Restrict CORS to known frontend origins — never wildcard in production
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',').map(o => o.trim())
// The page's own site is never cross-origin: browsers send Origin on same-site
// POSTs too (login), and KubeEZ is opened under several names (www., a LAN IP
// from a phone, :8090). Other sites get no CORS headers — the browser blocks
// them — instead of a 500.
const sameSite = (req, origin) => {
    try {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim()
        return !!host && new URL(origin).hostname.replace(/^\[|\]$/g, '') === host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    } catch { return false }
}
app.use(cors((req, callback) => {
    const origin = req.headers.origin
    const ok = !origin || allowedOrigins.includes(origin) || sameSite(req, origin)
    callback(null, { origin: ok, credentials: true })
}))
app.use(cookieParser())

// Stripe routes MUST be before express.json() because webhook needs raw body
app.use('/api/stripe', stripeRoutes)

app.use(express.json())
app.use(requestLogger) // Structured logging

// Rate Limiting (DDoS Protection)
app.use('/api/', apiLimiter) // Apply to all API routes
app.use('/api/auth/login', authLimiter)
app.use('/api/auth/setup', authLimiter)
app.use('/api/auth/register', authLimiter)
app.use('/api/auth/change-password', authLimiter)

// Public Auth & System Config Routes
app.get('/api/config', (req, res) => {
    const mode = process.env.KUBEEZ_MODE || 'self-hosted'
    res.json({
        mode,
        tunnelsEnabled: mode === 'saas',
        version: '2.1.0',
        features: {
            saasTunnels: mode === 'saas',
            incidentRemediation: true,
            licensing: true
        }
    })
})

app.get('/api/auth/status', (req, res) => {
    res.json({ setupRequired: authService.isSetupRequired() })
})

// Shared signup validation (setup + register + reset)
// Same rule for setup, register, reset, change-password and team members
const validatePassword = passwordProblem
function validateUsername(username) {
    if (typeof username !== 'string' || username.length < 3 || username.length > 32) return 'Username must be 3-32 characters'
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) return 'Username can only contain letters, numbers, ".", "-" and "_"'
    return null
}

app.post('/api/auth/setup', async (req, res) => {
    try {
        const { username, password, email } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' })
        const inputError = validateUsername(username) || validatePassword(password)
        if (inputError) return res.status(400).json({ error: inputError })
        if (!authService.isSetupRequired()) {
            return res.status(400).json({ error: 'Setup already completed. Please register or login.' })
        }
        const token = await authService.registerUser(username, password, email, { setup: true })
        const decoded = authService.verifyToken(token)
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        })
        res.json({ token, user: { id: decoded?.id, username: decoded?.username || username, email: decoded?.email, role: decoded?.role || 'admin', orgId: decoded?.orgId } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email } = req.body
        // While no account exists, only /setup may create the first one (it becomes the
        // platform super admin) — otherwise any visitor of a fresh server could take it over.
        if (authService.isSetupRequired()) {
            return res.status(403).json({ error: 'This server is not set up yet. The administrator must complete the initial setup first.' })
        }
        if (!username || !password || !email) return res.status(400).json({ error: 'Username, password, and email are required' })
        const inputError = validateUsername(username) || validatePassword(password)
            || (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? 'Please enter a valid email address' : null)
        if (inputError) return res.status(400).json({ error: inputError })
        const token = await authService.registerUser(username, password, email)
        const decoded = authService.verifyToken(token)
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        })
        res.json({ token, user: { id: decoded?.id, username: decoded?.username || username, email: decoded?.email, role: decoded?.role || 'user', orgId: decoded?.orgId } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

// What the login page can offer (no secrets): reset by email only when this
// server can actually send email
app.get('/api/auth/options', (req, res) => {
    res.json({ emailReset: mailConfigured(), selfHosted: process.env.KUBEEZ_MODE !== 'saas' })
})

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    try {
        const identifier = String(req.body?.identifier || req.body?.email || '').trim();
        if (!identifier) return res.status(400).json({ error: 'Enter your email address or username' });
        await authService.forgotPassword(identifier);
        res.json({ message: 'If an account with this email or username exists, a 6-digit code was sent to its email address.' });
    } catch (e) {
        res.status(e.code === 'NO_SMTP' ? 503 : 500).json({ error: e.message, code: e.code });
    }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        const email = String(req.body?.identifier || req.body?.email || '').trim();
        if (!email || !token || !newPassword) return res.status(400).json({ error: 'Email or username, reset code and new password are required' });
        const pwError = validatePassword(newPassword);
        if (pwError) return res.status(400).json({ error: pwError });
        await authService.resetPassword(email, token, newPassword);
        res.json({ message: 'Password reset successfully. You can now login.' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body
        const token = await authService.login(username, password)
        const decoded = authService.verifyToken(token)
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        })
        res.json({ token, user: { id: decoded?.id, username: decoded?.username, email: decoded?.email, role: decoded?.role, orgId: decoded?.orgId } })
    } catch (e) {
        res.status(401).json({ error: e.message })
    }
})

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' })
    res.json({ message: 'Logged out' })
})

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, email: req.user.email, role: req.user.role, orgId: req.user.orgId })
})

// Protected Routes
app.use('/api', licenseRoutes)
app.use('/api', agentRoutes)
app.use('/api', usersRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/incidents', incidentsRoutes)
app.use('/api/superadmin', superadminRoutes)
app.use('/api/offsite', offsiteRoutes)
app.use('/api/notifications', requireAuth, notificationsRoutes)
app.use('/api/clusters', requireAuth, installationRoutes)
app.use('/api/nodes', requireAuth, nodeVerificationRoutes)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the bundled agent script
app.use(express.static(path.join(__dirname, '../public')));

// Gateway Agent installers — they install the agent as a service (systemd /
// launchd / Scheduled Task) so it survives reboots and crashes. Read per request
// so an update ships without a rebuild.
const AGENT_INSTALLERS = { sh: 'agent-install.sh', ps1: 'agent-install.ps1' }
app.get('/agent-install.:ext(sh|ps1)', (req, res) => {
    const file = path.join(__dirname, 'automation/agent', AGENT_INSTALLERS[req.params.ext])
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.send(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
})


// Server internals (hostname, OS, Node.js, CPU, memory) are for the platform
// super admin only — every SaaS customer is an "admin" of their own workspace.
app.use('/api/health/detailed', requireAuth, (req, res, next) => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Super Admin access required' })
    next()
})
app.use('/api/health/backups', requireAuth, (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' })
    next()
})
app.use('/api/health', healthRouter)

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    // Expected path: /ws/installation/:id or similar
    // Authentication Check
    const url = new URL(req.url, `http://${req.headers.host}`)
    let token = url.searchParams.get('token')
    const pathname = url.pathname

    if (!token) {
        // Try cookie
        const cookieHeader = req.headers.cookie || ''
        const cookieToken = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('token='))?.split('=')[1]
        if (cookieToken) token = cookieToken
    }

    if (!token) {
        console.log('WebSocket connection rejected: No token provided')
        ws.close(4001, 'Unauthorized: Check credentials')
        return
    }

    let user = null
    if (!pathname.startsWith('/ws/agent')) {
        try {
            user = authService.verifyToken(token)
            if (!user) {
                console.log('WebSocket connection rejected: Invalid token')
                ws.close(4001, 'Unauthorized: Invalid token')
                return
            }
        } catch (err) {
            console.log('WebSocket connection rejected: Token verification failed', err.message)
            ws.close(4001, 'Unauthorized')
            return
        }
    }

    const forbid = () => ws.close(4003, 'Forbidden')

    // Routing based on pathname
    if (pathname.startsWith('/ws/installation')) {
        const id = pathname.split('/').pop()
        const inst = installationManager.getStatus(id)
        if (!inst || !canAccessResource(user, inst)) {
            console.log(`WebSocket: Installation stream rejected for ${id} (not found or not owned)`)
            return forbid()
        }
        console.log(`WebSocket: Installation stream connected for ${id}`)
        installationManager.addClient(id, ws)

        // Keepalive: send a heartbeat every 25s so idle periods (60s waits,
        // slow kubectl rollouts) don't trip Cloudflare's ~100s WS idle timeout
        // and drop the connection with code 1006.
        const heartbeat = setInterval(() => {
            if (ws.readyState === 1) {
                try {
                    ws.ping()
                    ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }))
                } catch (_) { /* ignore */ }
            }
        }, 25000)

        ws.on('close', () => {
            clearInterval(heartbeat)
            installationManager.removeClient(id, ws)
        })

        ws.send(JSON.stringify({ type: 'log', level: 'info', message: 'Connected to KubeEZ installation stream' }))
    }
    else if (pathname.startsWith('/ws/orbital')) {
        const id = pathname.split('/').pop()
        if (!can(user.role, 'terminal:access')) {
            console.log(`WebSocket: Orbital Terminal rejected for ${user.username} (no terminal:access)`)
            return forbid()
        }
        console.log(`WebSocket: Orbital Terminal connected for ${id}`)

        // SSH sessions belong to THIS connection only — never shared by clusterId
        const sessionKey = uuidv4()
        const send = (payload) => { if (ws.readyState === 1) ws.send(JSON.stringify(payload)) }

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message)
                if (data.type !== 'command' || typeof data.command !== 'string' || !data.command.trim()) return

                // Re-check on every command: role may have changed, cluster may be gone
                const current = authService.verifyToken(token)
                if (!current || !can(current.role, 'terminal:access')) return ws.close(4003, 'Forbidden')

                // Nodes + credentials come ONLY from the server-side cluster record
                const clusters = await installationManager.getSavedClusters()
                const cluster = clusters.find(c => c.id === (data.clusterId || id))
                if (!cluster || !canAccessResource(current, cluster)) {
                    return send({ type: 'terminal-output', nodeIp: 'system', streamType: 'error', content: 'Unauthorized access to this cluster\n' })
                }

                const requestedIps = new Set((Array.isArray(data.nodes) ? data.nodes : [])
                    .map(n => (typeof n === 'string' ? n : n?.ip)).filter(Boolean))
                const targets = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
                    .filter(n => requestedIps.size === 0 || requestedIps.has(n.ip))
                    .map(n => ({ ...n, ownerId: cluster.ownerId, orgId: cluster.orgId }))

                await terminalService.broadcastCommand(sessionKey, targets, data.command, (nodeIp, type, chunk) => {
                    send({ type: 'terminal-output', nodeIp, streamType: type, content: chunk })
                })
            } catch (err) {
                console.error('Orbital command failed:', err)
            }
        })

        ws.on('close', () => {
            console.log(`WebSocket: Orbital Terminal disconnected for ${id}`)
            terminalService.closeSession(sessionKey)
        })
    }
    else if (pathname.startsWith('/ws/agent')) {
        // Reverse tunnel agent connection
        const agentId = pathname.split('/').pop()
        const agentToken = url.searchParams.get('token') || token
        console.log(`WebSocket: Agent tunnel connecting for ${agentId}`);
        (async () => {
            await agentService.onAgentConnect(ws, agentId, agentToken)
        })()
    }
    else {
        ws.close(4004, 'Unknown stream')
    }
})

import { incidentDetector } from './services/incidentDetector.js'

// Global error handler — always return JSON, never HTML (prevents CORS errors becoming HTML pages)
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500
    res.status(status).json({ error: err.message || 'Internal server error' })
})

const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
    // Initialize services
    clusterStore.backfillOrgIds(ownerId => authService.getUserById(ownerId)?.orgId)
        .catch(err => console.error('[ClusterStore] orgId backfill failed:', err.message))
    BackupService.initialize()
    BackupService.startDailyScheduler(24)  // Daily config backups for all users
    incidentDetector.init().catch(err => console.error('[IncidentDetector] Failed to init:', err))

    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║   🚀 KubeEZ Backend Server                           ║
║                                                       ║
║   Server running on: http://localhost:${PORT}        ║
║   WebSocket endpoint: ws://localhost:${PORT}/ws      ║
║                                                       ║
║   API Routes:                                        ║
║   - POST /api/clusters/install                       ║
║   - GET  /api/clusters/:id/status                    ║
║   - GET  /api/health                                 ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `)
})

export { wss }
