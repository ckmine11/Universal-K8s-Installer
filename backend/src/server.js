import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import cors from 'cors'
import { v4 as uuidv4 } from 'uuid'
import installationRoutes from './routes/installation.js'
import nodeVerificationRoutes from './routes/nodeVerification.js'
import { installationManager } from './services/installationManager.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server }) // Allow all paths, we filter below

import { authService } from './services/authService.js'
import { requireAuth } from './middleware/authMiddleware.js'

// Middleware
app.use(cors())
app.use(express.json())

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

    const pathParts = pathname.split('/').filter(p => p && p !== 'ws' && p !== 'installation')
    const installationId = pathParts[pathParts.length - 1]

    console.log(`WebSocket client connected for installation: ${installationId}`)

    // Register client for this installation
    installationManager.addClient(installationId, ws)

    ws.on('close', () => {
        console.log(`WebSocket client disconnected for installation: ${installationId}`)
        installationManager.removeClient(installationId, ws)
    })

    ws.on('error', (error) => {
        console.error('WebSocket error:', error)
    })

    // Send initial connection message
    ws.send(JSON.stringify({
        type: 'log',
        level: 'info',
        message: 'Connected to KubeEZ installation stream'
    }))
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
