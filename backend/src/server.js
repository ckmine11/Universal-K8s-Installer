import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import rateLimit from 'express-rate-limit'
import { v4 as uuidv4 } from 'uuid'
import installationRoutes from './routes/installation.js'
import nodeVerificationRoutes from './routes/nodeVerification.js'
import { installationManager } from './services/installationManager.js'
import { terminalService } from './services/terminalService.js'
import { trafficSniffer } from './services/trafficSniffer.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server }) // Allow all paths, we filter below

import { authService } from './services/authService.js'
import { requireAuth } from './middleware/authMiddleware.js'

import { requestLogger, errorLogger } from './middleware/logger.js'

// Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP to avoid frontend conflicts (API-focused)
    crossOriginEmbedderPolicy: false
}))
app.use(compression()) // Gzip compression
app.use(cors())
app.use(express.json())
app.use(requestLogger) // Structured logging

// Rate Limiting (DDoS Protection)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // Limit each IP to 500 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests, please try again later.' }
})
app.use('/api/', limiter) // Apply to all API routes

// Public Auth Routes
app.get('/api/auth/status', (req, res) => {
    res.json({ setupRequired: authService.isSetupRequired() })
})

app.post('/api/auth/setup', async (req, res) => {
    try {
        const { username, password } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' })
        const token = await authService.registerAdmin(username, password)
        res.json({ token, user: { username, role: 'admin' } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body
        const token = await authService.login(username, password)
        res.json({ token })
    } catch (e) {
        res.status(401).json({ error: e.message })
    }
})

// Protected Routes
app.use('/api/clusters', requireAuth, installationRoutes)
app.use('/api/nodes', requireAuth, nodeVerificationRoutes)

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() })
})

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    // Expected path: /ws/installation/:id or similar
    // Authentication Check
    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    const pathname = url.pathname

    if (!token) {
        console.log('WebSocket connection rejected: No token provided')
        ws.close(4001, 'Unauthorized: Check credentials')
        return
    }

    try {
        const decoded = authService.verifyToken(token)
        if (!decoded) {
            console.log('WebSocket connection rejected: Invalid token')
            ws.close(4001, 'Unauthorized: Invalid token')
            return
        }
    } catch (err) {
        console.log('WebSocket connection rejected: Token verification failed', err.message)
        ws.close(4001, 'Unauthorized')
        return
    }

    // Routing based on pathname
    if (pathname.startsWith('/ws/installation')) {
        const id = pathname.split('/').pop()
        console.log(`WebSocket: Installation stream connected for ${id}`)
        installationManager.addClient(id, ws)
        ws.on('close', () => installationManager.removeClient(id, ws))

        ws.send(JSON.stringify({ type: 'log', level: 'info', message: 'Connected to KubeEZ installation stream' }))
    }
    else if (pathname.startsWith('/ws/orbital')) {
        const id = pathname.split('/').pop()
        console.log(`WebSocket: Orbital Terminal connected for ${id}`)

        ws.on('message', async (message) => {
            try {
                const data = JSON.parse(message)
                if (data.type === 'command' && data.clusterId && data.nodes) {
                    await terminalService.broadcastCommand(data.clusterId, data.nodes, data.command, (nodeIp, type, chunk) => {
                        ws.send(JSON.stringify({ type: 'terminal-output', nodeIp, streamType: type, content: chunk }))
                    })
                }
            } catch (err) {
                console.error('Orbital command failed:', err)
            }
        })

        ws.on('close', () => {
            console.log(`WebSocket: Orbital Terminal disconnected for ${id}`)
            terminalService.closeSession(id)
        })
    }
    else if (pathname.startsWith('/ws/traffic')) {
        const id = pathname.split('/').pop()
        console.log(`WebSocket: Traffic stream connected for ${id}`)

        const onPulse = (data) => {
            if (data.clusterId === id) {
                ws.send(JSON.stringify({ type: 'traffic-pulse', ...data }))
            }
        }

        trafficSniffer.on('traffic-pulse', onPulse)
        trafficSniffer.startSniffing(id)

        ws.on('close', () => {
            console.log(`WebSocket: Traffic stream disconnected for ${id}`)
            trafficSniffer.removeListener('traffic-pulse', onPulse)
            // Option to stop sniffing if no clients left
        })
    }
})

const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
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
