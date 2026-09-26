import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import path from 'path';
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
import { trafficSniffer } from './services/trafficSniffer.js'
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

// Restrict CORS to known frontend origins — never wildcard in production
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',').map(o => o.trim())
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
        callback(new Error('CORS: origin not allowed'))
    },
    credentials: true
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

app.post('/api/auth/setup', async (req, res) => {
    try {
        const { username, password, email } = req.body
        if (!username || !password) return res.status(400).json({ error: 'Missing credentials' })
        if (!authService.isSetupRequired()) {
            return res.status(400).json({ error: 'Setup already completed. Please register or login.' })
        }
        const token = await authService.registerUser(username, password, email)
        const decoded = authService.verifyToken(token)
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        })
        res.json({ token, user: { id: decoded?.id, username: decoded?.username || username, role: decoded?.role || 'admin', orgId: decoded?.orgId } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password, email } = req.body
        if (!username || !password || !email) return res.status(400).json({ error: 'Username, password, and email are required' })
        const token = await authService.registerUser(username, password, email)
        const decoded = authService.verifyToken(token)
        res.cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000
        })
        res.json({ token, user: { id: decoded?.id, username: decoded?.username || username, role: decoded?.role || 'user', orgId: decoded?.orgId } })
    } catch (e) {
        res.status(400).json({ error: e.message })
    }
})

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });
        await authService.forgotPassword(email);
        res.json({ message: 'If an account exists, a reset code has been sent.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
    try {
        const { token, newPassword } = req.body;
        if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required' });
        await authService.resetPassword(token, newPassword);
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
        res.json({ token, user: { id: decoded?.id, username: decoded?.username, role: decoded?.role, orgId: decoded?.orgId } })
    } catch (e) {
        res.status(401).json({ error: e.message })
    }
})

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' })
    res.json({ message: 'Logged out' })
})

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ id: req.user.id, username: req.user.username, role: req.user.role, orgId: req.user.orgId })
})

// Protected Routes
app.use('/api', licenseRoutes)
app.use('/api', agentRoutes)
app.use('/api', usersRoutes)
app.use('/api/billing', billingRoutes)
app.use('/api/incidents', incidentsRoutes)
app.use('/api/superadmin', superadminRoutes)
app.use('/api/clusters', requireAuth, installationRoutes)
app.use('/api/nodes', requireAuth, nodeVerificationRoutes)

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the bundled agent script
app.use(express.static(path.join(__dirname, '../public')));

app.get('/agent-install.sh', (req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.send(`#!/usr/bin/env bash
# KubeEZ Gateway Agent Installer (Mac/Linux)
set -e

TOKEN=""
AGENT_ID=""
SERVER=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --agent-id) AGENT_ID="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$TOKEN" ] || [ -z "$AGENT_ID" ] || [ -z "$SERVER" ]; then
  echo "ERROR: Missing required arguments: --token, --agent-id, --server"
  exit 1
fi

echo "[KubeEZ Gateway] Setting up Agent..."

AGENT_DIR="$HOME/.kubeez-agent"
mkdir -p "$AGENT_DIR"
cd "$AGENT_DIR"

NODE_BIN="node"
if ! command -v node &>/dev/null; then
  echo "[KubeEZ Gateway] Node.js not found. Downloading portable Node.js..."
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ]; then ARCH="x64"; fi
  if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi
  NODE_VER="v18.20.2"
  NODE_DIR="node-$NODE_VER-$OS-$ARCH"
  NODE_TAR="$NODE_DIR.tar.gz"
  
  if [ ! -f "bin/node" ]; then
    curl -sfL -o node.tar.gz "https://nodejs.org/dist/$NODE_VER/$NODE_TAR" || { echo "Failed to download Node.js for $OS-$ARCH"; exit 1; }
    tar -xzf node.tar.gz
    mkdir -p bin
    mv $NODE_DIR/bin/node bin/node
    rm -rf $NODE_DIR node.tar.gz
  fi
  NODE_BIN="$AGENT_DIR/bin/node"
fi

HOST_URL=$(echo "$SERVER" | sed 's/ws/http/')
curl -sfL "$HOST_URL/agent-bundle.js" -o agent-bundle.js

echo "[KubeEZ Gateway] Starting Agent in background..."
nohup $NODE_BIN agent-bundle.js --token "$TOKEN" --agent-id "$AGENT_ID" --server "$SERVER" > agent.log 2>&1 &
echo $! > agent.pid

echo "=========================================================="
echo " [SUCCESS] KubeEZ Gateway Agent is running in background! "
echo " You can safely close this terminal."
echo " To view logs, run: cat $AGENT_DIR/agent.log"
echo " To stop agent, run: kill \$(cat $AGENT_DIR/agent.pid)"
echo "=========================================================="
`)
})

app.get('/agent-install.ps1', (req, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.send(`
param (
    [Parameter(Mandatory=$true)][string]$Token,
    [Parameter(Mandatory=$true)][string]$AgentId,
    [Parameter(Mandatory=$true)][string]$ServerUrl
)

Write-Host "[KubeEZ Gateway] Setting up Agent..." -ForegroundColor Cyan

$AgentDir = Join-Path $HOME ".kubeez-agent"
if (-not (Test-Path $AgentDir)) {
    New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
}
Set-Location $AgentDir

$NodeBin = "node"
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) {
    Write-Host "[KubeEZ Gateway] Node.js not found. Downloading portable Node.js..." -ForegroundColor Gray
    $NodeVer = "v18.20.2"
    $NodeZip = "node-$NodeVer-win-x64.zip"
    $NodeUrl = "https://nodejs.org/dist/$NodeVer/$NodeZip"
    
    if (-not (Test-Path "bin\\node.exe")) {
        Invoke-WebRequest -Uri $NodeUrl -OutFile "node.zip" -UseBasicParsing
        Expand-Archive -Path "node.zip" -DestinationPath "." -Force
        New-Item -ItemType Directory -Force -Path "bin" | Out-Null
        Move-Item -Path "node-$NodeVer-win-x64\\node.exe" -Destination "bin\\node.exe" -Force
        Remove-Item -Path "node-$NodeVer-win-x64" -Recurse -Force
        Remove-Item -Path "node.zip" -Force
    }
    $NodeBin = Join-Path $AgentDir "bin\\node.exe"
}

$HttpUrl = $ServerUrl -replace "^ws", "http"
Invoke-WebRequest -Uri "$HttpUrl/agent-bundle.js" -OutFile "agent-bundle.js" -UseBasicParsing

Write-Host "[KubeEZ Gateway] Starting Agent in background..." -ForegroundColor Green
$ProcessArgs = "agent-bundle.js --token $Token --agent-id $AgentId --server $ServerUrl"
$Proc = Start-Process -FilePath $NodeBin -ArgumentList $ProcessArgs -WindowStyle Hidden -PassThru
$Proc.Id | Out-File -FilePath "agent.pid"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " [SUCCESS] KubeEZ Gateway Agent is running in background! " -ForegroundColor Green
Write-Host " You can safely close this terminal." -ForegroundColor White
Write-Host " To stop agent, run: Stop-Process -Id (Get-Content .kubeez-agent\\agent.pid) -Force" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan
`)
})


// Secure Advanced Health & Backup Info (Only Admins allowed)
app.use('/api/health/detailed', requireAuth, (req, res, next) => {
    if (req.user.role !== 'admin' && req.user.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' })
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

    if (!pathname.startsWith('/ws/agent')) {
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
    else if (pathname.startsWith('/ws/agent')) {
        // Reverse tunnel agent connection
        const agentId = pathname.split('/').pop()
        const agentToken = url.searchParams.get('token') || token
        console.log(`WebSocket: Agent tunnel connecting for ${agentId}`);
        (async () => {
            await agentService.onAgentConnect(ws, agentId, agentToken)
        })()
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

import { incidentDetector } from './services/incidentDetector.js'

// Global error handler — always return JSON, never HTML (prevents CORS errors becoming HTML pages)
app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500
    res.status(status).json({ error: err.message || 'Internal server error' })
})

const PORT = process.env.PORT || 3000

server.listen(PORT, () => {
    // Initialize services
    BackupService.initialize()
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
