import express from 'express'
import { agentService } from '../services/agentService.js'
import { requireAuth } from '../middleware/authMiddleware.js'

const router = express.Router()

// Generate a new agent registration token + install command
router.post('/agent/token', requireAuth, async (req, res) => {
    try {
        const { label } = req.body
        const { id: ownerId, username: ownerUsername, orgId } = req.user

        const record = await agentService.generateToken(ownerId, ownerUsername, orgId, label)

        // Detect host for the install command (from request, or env fallback)
        const hostHeader = req.get('x-forwarded-host') || req.get('host')
        const host = process.env.KUBEEZ_PUBLIC_URL || `${req.protocol}://${hostHeader}`
        const wsHost = host.replace(/^http/, 'ws')
        // Generate universal NodeJS command
        const ts = Date.now()
        // Quote the URL — zsh (default on macOS) treats the '?' in the query string
        // as a glob and errors with "no matches found" if left unquoted.
        const installCommandLinux = `curl -sfL "${host}/agent-install.sh?v=${ts}" | bash -s -- --token ${record.token} --agent-id ${record.agentId} --server ${wsHost}`
        
        const psCmd = `$t="$env:TEMP\\kbagent.ps1"; Invoke-WebRequest -Uri "${host}/agent-install.ps1?v=${ts}" -OutFile $t; & $t -Token ${record.token} -AgentId ${record.agentId} -ServerUrl ${wsHost}`
        const base64Cmd = Buffer.from(psCmd, 'utf16le').toString('base64')
        const installCommandWindows = `powershell -ExecutionPolicy Bypass -EncodedCommand ${base64Cmd}`

        res.json({
            agentId: record.agentId,
            token: record.token,
            label: record.label,
            installCommandLinux,
            installCommandWindows,
            status: 'pending',
            createdAt: record.createdAt
        })
    } catch (error) {
        console.error('Agent token creation error:', error)
        res.status(500).json({ error: error.message })
    }
})

// List all agents for current user (admin sees all)
router.get('/agent/list', requireAuth, async (req, res) => {
    try {
        const agents = await agentService.getAgentsByOwner(req.user.id, req.user.role, req.user.orgId)

        // Enrich with live connection status
        const enriched = agents.map(a => ({
            agentId: a.agentId,
            label: a.label,
            ownerId: a.ownerId,
            ownerUsername: a.ownerUsername,
            registeredNodeIps: a.registeredNodeIps,
            status: agentService.isAgentOnline(a.agentId) ? 'online' : (a.status === 'pending' ? 'pending' : 'offline'),
            lastSeen: a.lastSeen,
            createdAt: a.createdAt
        }))

        res.json(enriched)
    } catch (error) {
        console.error('Agent list error:', error)
        res.status(500).json({ error: error.message })
    }
})

// Check if any agent is online (simple boolean check for wizard prerequisite gate)
router.get('/agent/has-online', requireAuth, async (req, res) => {
    try {
        const agents = await agentService.getAgentsByOwner(req.user.id, req.user.role, req.user.orgId)
        const hasOnline = agents.some(a => agentService.isAgentOnline(a.agentId))
        res.json({ hasOnline, total: agents.length })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// Check IP-to-agent mapping (wizard uses this to show agent status per node)
router.post('/agent/check-ips', requireAuth, async (req, res) => {
    try {
        const { ips } = req.body
        if (!Array.isArray(ips)) return res.status(400).json({ error: 'ips must be an array' })
        const result = await agentService.getStatusForIps(ips, req.user.id, req.user.role, req.user.orgId)
        res.json(result)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// Delete an agent
router.delete('/agent/:agentId', requireAuth, async (req, res) => {
    try {
        await agentService.deleteAgent(req.params.agentId, req.user.id, req.user.role, req.user.orgId)
        res.json({ success: true, message: 'Agent removed successfully' })
    } catch (error) {
        const status = error.message === 'Unauthorized' ? 403 : error.message === 'Agent not found' ? 404 : 500
        res.status(status).json({ error: error.message })
    }
})

export default router
