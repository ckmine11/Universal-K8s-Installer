import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_DIR = path.join(__dirname, '../../data')
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json')

class AgentService {
    constructor() {
        this.agentSockets = new Map() // agentId -> WebSocket
        this.pendingCommands = new Map() // commandId -> { resolve, reject, timeout }
        this.ensureDataDir()
    }

    ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
        if (!fs.existsSync(AGENTS_FILE)) {
            fs.writeFileSync(AGENTS_FILE, JSON.stringify([]))
        }
    }

    // ─── Persistence ───────────────────────────────────────────
    async _readAgents() {
        try {
            const raw = await fs.promises.readFile(AGENTS_FILE, 'utf8')
            return JSON.parse(raw)
        } catch {
            return []
        }
    }

    async _writeAgents(agents) {
        await fs.promises.writeFile(AGENTS_FILE, JSON.stringify(agents, null, 2))
    }

    // Serialize every read-modify-write of agents.json. Pings arrive every 20s
    // per agent; without this a concurrent status update could overwrite a
    // freshly created (or deleted) agent record.
    async _mutate(fn) {
        const run = (this._lock || Promise.resolve()).then(async () => {
            const agents = await this._readAgents()
            const result = await fn(agents)
            await this._writeAgents(agents)
            return result
        })
        this._lock = run.catch(() => {})
        return run
    }

    // ─── Token / Registration ────────────────────────────────────
    async generateToken(ownerId, ownerUsername, orgId, label = '') {
        const agentId = uuidv4()
        const token = uuidv4()

        const record = {
            agentId,
            token,
            ownerId,
            ownerUsername,
            orgId,
            label: label || `Agent-${agentId.slice(0, 6)}`,
            registeredNodeIps: [],
            status: 'pending', // pending | online | offline
            lastSeen: null,
            createdAt: new Date().toISOString()
        }

        await this._mutate(agents => { agents.push(record) })
        return record
    }

    async getAgentByToken(token) {
        const agents = await this._readAgents()
        return agents.find(a => a.token === token) || null
    }

    async getAgentById(agentId) {
        const agents = await this._readAgents()
        return agents.find(a => a.agentId === agentId) || null
    }

    async getAgentsByOwner(ownerId, role, orgId) {
        const agents = await this._readAgents()
        return agents.filter(a =>
            (orgId && a.orgId === orgId) ||
            (ownerId && a.ownerId === ownerId)
        )
    }

    async deleteAgent(agentId, ownerId, role, orgId) {
        await this._mutate(agents => {
            const idx = agents.findIndex(a => a.agentId === agentId)
            if (idx < 0) throw new Error('Agent not found')

            const agent = agents[idx]
            const isAuthorized = (agent.orgId && agent.orgId === orgId) || (!agent.orgId && agent.ownerId === ownerId)
            if (!isAuthorized) {
                throw new Error('Unauthorized')
            }
            agents.splice(idx, 1)
        })

        // Disconnect active socket if online
        if (this.agentSockets.has(agentId)) {
            try { this.agentSockets.get(agentId).close(1000, 'Agent removed') } catch { }
            this.agentSockets.delete(agentId)
        }
        return true
    }

    // ─── WebSocket Lifecycle ─────────────────────────────────────
    async onAgentConnect(ws, agentId, token) {
        const agent = await this.getAgentByToken(token)
        if (!agent || agent.agentId !== agentId) {
            ws.close(4001, 'Invalid agent token')
            return false
        }

        // A reconnect replaces the previous socket — close the stale one so it
        // can't keep receiving jobs.
        const previous = this.agentSockets.get(agentId)
        if (previous && previous !== ws) {
            try { previous.close(4000, 'Replaced by a newer connection') } catch { }
        }
        this.agentSockets.set(agentId, ws)

        // Mark online + update lastSeen
        await this._updateAgentStatus(agentId, 'online')

        // Auto-register as gateway if not already marked — any connected agent can tunnel SSH
        if (!agent.registeredNodeIps?.includes('gateway')) {
            await this._updateAgentIps(agentId, [...(agent.registeredNodeIps || []), 'gateway'])
        }

        console.log(`[AgentService] Agent ${agentId} (${agent.label}) connected as gateway`)

        // Heartbeat
        ws.on('message', async (raw) => {
            try {
                const msg = JSON.parse(raw.toString())
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }))
                    await this._updateAgentStatus(agentId, 'online')
                } else if (msg.type === 'command-result') {
                    this._resolveCommand(agentId, msg.commandId, msg)
                } else if (msg.type === 'register-ips') {
                    await this._updateAgentIps(agentId, msg.ips || [])
                }
            } catch (e) {
                console.error('[AgentService] Failed to parse agent message:', e.message)
            }
        })

        ws.on('close', async () => {
            // Only tear down if THIS socket is still the active one — the close of
            // a replaced socket must not unregister its newer reconnection.
            if (this.agentSockets.get(agentId) !== ws) return
            this.agentSockets.delete(agentId)
            this._rejectPendingForAgent(agentId, new Error(`Agent ${agentId} disconnected`))
            await this._updateAgentStatus(agentId, 'offline')
            console.log(`[AgentService] Agent ${agentId} disconnected`)
        })

        ws.on('error', (err) => {
            console.error(`[AgentService] Agent ${agentId} error:`, err.message)
        })

        return true
    }

    async _updateAgentStatus(agentId, status) {
        try {
            await this._mutate(agents => {
                const agent = agents.find(a => a.agentId === agentId)
                if (agent) {
                    agent.status = status
                    agent.lastSeen = new Date().toISOString()
                }
            })
        } catch (e) {
            console.error('[AgentService] Failed to update agent status:', e.message)
        }
    }

    async _updateAgentIps(agentId, ips) {
        try {
            await this._mutate(agents => {
                const agent = agents.find(a => a.agentId === agentId)
                if (agent) agent.registeredNodeIps = Array.isArray(ips) ? ips : []
            })
        } catch (e) {
            console.error('[AgentService] Failed to update agent IPs:', e.message)
        }
    }

    // ─── Command Relay ────────────────────────────────────────────
    isAgentOnline(agentId) {
        return this.agentSockets.has(agentId)
    }

    // Find the online agent that has a given IP registered
    async findAgentForIp(ip, ownerId, role, orgId) {
        const agents = await this.getAgentsByOwner(ownerId, role, orgId)
        const onlineAgents = agents.filter(a => this.isAgentOnline(a.agentId))
        return onlineAgents.find(a => a.registeredNodeIps.includes(ip)) || null
    }

    // Get the first available Gateway agent for the user
    async getGatewayAgentForOwner(ownerId, role, orgId) {
        const agents = await this.getAgentsByOwner(ownerId, role, orgId)
        const onlineAgents = agents.filter(a => this.isAgentOnline(a.agentId))
        // Prefer explicitly registered gateway, fallback to any online agent
        return onlineAgents.find(a => a.registeredNodeIps?.includes('gateway'))
            || onlineAgents[0]
            || null
    }

    // Send a command through the agent and wait for result (promise-based relay)
    async relayCommand(agentId, command, timeoutMs = 60000) {
        const ws = this.agentSockets.get(agentId)
        if (!ws) throw new Error(`Agent ${agentId} is not online`)

        const commandId = uuidv4()
        const payload = { type: 'execute', commandId, command }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(commandId)
                reject(new Error(`Command relay timeout after ${timeoutMs}ms`))
            }, timeoutMs)

            this.pendingCommands.set(commandId, { agentId, resolve, reject, timeout })
            ws.send(JSON.stringify(payload))
        })
    }

    // Proxy an SSH command through a Gateway Agent
    async relaySSH(agentId, nodeConfig, command, timeoutMs = 600000) {
        const ws = this.agentSockets.get(agentId)
        if (!ws) throw new Error(`Agent ${agentId} is not online`)

        const commandId = uuidv4()
        const payload = { 
            type: 'execute-ssh', 
            commandId, 
            ip: nodeConfig.ip,
            username: nodeConfig.username,
            password: nodeConfig.password,
            privateKey: nodeConfig.sshKey,
            command 
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(commandId)
                reject(new Error(`SSH relay timeout after ${timeoutMs}ms`))
            }, timeoutMs)

            this.pendingCommands.set(commandId, { agentId, resolve, reject, timeout })
            ws.send(JSON.stringify(payload))
        })
    }

    _rejectPendingForAgent(agentId, error) {
        for (const [commandId, pending] of this.pendingCommands) {
            if (pending.agentId !== agentId) continue
            clearTimeout(pending.timeout)
            this.pendingCommands.delete(commandId)
            pending.reject(error)
        }
    }

    _resolveCommand(agentId, commandId, result) {
        const pending = this.pendingCommands.get(commandId)
        // An agent may only answer commands that were sent to IT
        if (pending && pending.agentId === agentId) {
            clearTimeout(pending.timeout)
            this.pendingCommands.delete(commandId)
            if (result.exitCode !== 0) {
                const err = new Error(`Remote command failed: ${result.stderr}`)
                err.stderr = result.stderr
                err.exitCode = result.exitCode
                pending.reject(err)
            } else {
                pending.resolve(result)
            }
        }
    }

    // Get agent status summary for a list of IPs
    async getStatusForIps(ips, ownerId, role, orgId) {
        const agents = await this.getAgentsByOwner(ownerId, role, orgId)
        return ips.map(ip => {
            const agent = agents.find(a => a.registeredNodeIps.includes(ip))
            if (!agent) return { ip, status: 'no-agent', agentLabel: null }
            const online = this.isAgentOnline(agent.agentId)
            return {
                ip,
                agentId: agent.agentId,
                agentLabel: agent.label,
                status: online ? 'online' : 'offline',
                lastSeen: agent.lastSeen
            }
        })
    }
}

export const agentService = new AgentService()
