import { Duplex } from 'stream'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { randomUUID as uuidv4 } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomic } from '../utils/atomicWrite.js'
import { notifier } from './notifier.js'
const AGENT_OFFLINE_ALERT_MS = Number(process.env.KUBEEZ_AGENT_OFFLINE_ALERT_MS) || 5 * 60 * 1000

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


const AGENTS_FILE = path.join(DATA_DIR, 'agents.json')
// No message from an agent for this long → its connection is dead
const AGENT_DEAD_AFTER_MS = Number(process.env.KUBEEZ_AGENT_DEAD_AFTER_MS) || 60000

class AgentService {
    constructor() {
        this.agentSockets = new Map() // agentId -> WebSocket
        this.pendingCommands = new Map() // commandId -> { resolve, reject, timeout }
        this.agentCaps = new Map()       // agentId -> Set of capabilities the agent build offers
        this.offlineAlerts = new Map()   // agentId -> { timer, alerted }
        this.tcpStreams = new Map()      // streamId -> { agentId, duplex, opened }
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
        await writeFileAtomic(AGENTS_FILE, JSON.stringify(agents, null, 2))
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
        this._agentOnline(agent)

        // Mark online + update lastSeen
        await this._updateAgentStatus(agentId, 'online')

        // Auto-register as gateway if not already marked — any connected agent can tunnel SSH
        if (!agent.registeredNodeIps?.includes('gateway')) {
            await this._updateAgentIps(agentId, [...(agent.registeredNodeIps || []), 'gateway'])
        }

        console.log(`[AgentService] Agent ${agentId} (${agent.label}) connected as gateway`)

        // The agent pings every 20 s. A link that died silently (NAT / proxy /
        // power loss) never fires 'close' — drop it after 60 s of silence so the
        // agent shows offline at once and jobs fail fast instead of hanging.
        let lastHeard = Date.now()
        const watchdog = setInterval(() => {
            if (Date.now() - lastHeard > AGENT_DEAD_AFTER_MS) {
                console.log(`[AgentService] Agent ${agentId} silent for ${AGENT_DEAD_AFTER_MS / 1000}s — dropping the connection`)
                try { ws.terminate() } catch { }
            }
        }, Math.min(20000, AGENT_DEAD_AFTER_MS / 3))
        watchdog.unref?.()

        // Heartbeat
        ws.on('message', async (raw) => {
            lastHeard = Date.now()
            try {
                const msg = JSON.parse(raw.toString())
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }))
                    await this._updateAgentStatus(agentId, 'online')
                } else if (msg.type === 'command-result') {
                    this._resolveCommand(agentId, msg.commandId, msg)
                } else if (msg.type === 'register-ips') {
                    // Agent builds from before TCP streams send no caps
                    this.agentCaps.set(agentId, new Set(Array.isArray(msg.caps) ? msg.caps : []))
                    await this._updateAgentIps(agentId, msg.ips || [])
                } else if (msg.type === 'tcp-opened' || msg.type === 'tcp-data' || msg.type === 'tcp-close') {
                    this._onTcpMessage(agentId, msg)
                }
            } catch (e) {
                console.error('[AgentService] Failed to parse agent message:', e.message)
            }
        })

        ws.on('close', async () => {
            clearInterval(watchdog)
            // Only tear down if THIS socket is still the active one — the close of
            // a replaced socket must not unregister its newer reconnection.
            if (this.agentSockets.get(agentId) !== ws) return
            this.agentSockets.delete(agentId)
            this.agentCaps.delete(agentId)
            this._rejectPendingForAgent(agentId, new Error(`Agent ${agentId} disconnected`))
            this._closeTcpForAgent(agentId, new Error('The Gateway Agent disconnected'))
            this._agentOffline(agentId)
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

    // ─── Offline alerts: only after 5 minutes away (restarts and blips stay quiet) ──
    async _agentOffline(agentId) {
        const prev = this.offlineAlerts.get(agentId)
        if (prev?.timer) clearTimeout(prev.timer)
        const timer = setTimeout(async () => {
            if (this.agentSockets.has(agentId)) return
            const agent = (await this._readAgents().catch(() => [])).find(a => a.agentId === agentId)
            if (!agent) return
            this.offlineAlerts.set(agentId, { alerted: true })
            notifier.emit(agent.orgId, { type: 'agent_offline', severity: 'critical', key: `agent|${agentId}`, title: `Gateway Agent "${agent.label || agentId.slice(0, 8)}" is offline`, text: 'Clusters reached through it cannot be managed, monitored or healed until it reconnects. Check the machine it runs on.', link: '/agents' })
        }, AGENT_OFFLINE_ALERT_MS)
        timer.unref?.()
        this.offlineAlerts.set(agentId, { timer, alerted: false })
    }

    _agentOnline(agent) {
        const prev = this.offlineAlerts.get(agent.agentId)
        if (prev?.timer) clearTimeout(prev.timer)
        this.offlineAlerts.delete(agent.agentId)
        if (prev?.alerted) notifier.emit(agent.orgId, { type: 'agent_offline', severity: 'success', key: `agent-back|${agent.agentId}`, title: `Gateway Agent "${agent.label || agent.agentId.slice(0, 8)}" is back online`, link: '/agents' })
    }

    // ─── TCP streams through the agent ───────────────────────────
    /** Does this (online) agent build relay TCP streams? */
    agentSupports(agentId, cap) {
        return !!this.agentCaps.get(agentId)?.has(cap)
    }

    /**
     * A TCP connection to host:port as seen from nodeConfig's machine, through
     * the agent's SSH session to it. Resolves to a Duplex once it is open.
     */
    openTcp(agentId, nodeConfig, host, port, timeoutMs = 30000) {
        const ws = this.agentSockets.get(agentId)
        if (!ws) return Promise.reject(new Error(`Agent ${agentId} is not online`))
        if (!this.agentSupports(agentId, 'tcp')) {
            return Promise.reject(Object.assign(new Error('This Gateway Agent is too old for in-cluster web tools — reinstall it from the Tunnels page (one command, same token).'), { code: 'AGENT_OUTDATED' }))
        }
        const streamId = uuidv4()
        const send = (o) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)) } catch { } }
        let closedByUs = false
        const streams = this.tcpStreams
        const duplex = new Duplex({
            read() { },
            write(chunk, enc, cb) { send({ type: 'tcp-data', streamId, data: Buffer.from(chunk).toString('base64') }); cb() },
            final(cb) { closedByUs = true; send({ type: 'tcp-close', streamId }); cb() },
            destroy(err, cb) {
                streams.delete(streamId)
                if (!closedByUs) send({ type: 'tcp-close', streamId })
                cb(err)
            }
        })
        // An agent drop destroys the stream with an error — never let that be an
        // unhandled 'error' event (it would take the whole server down)
        duplex.on('error', () => { })
        const entry = { agentId, duplex, opened: false }
        streams.set(streamId, entry)
        return new Promise((resolve, reject) => {
            entry.timer = setTimeout(() => {
                this.tcpStreams.delete(streamId)
                send({ type: 'tcp-close', streamId })
                reject(new Error(`Could not reach ${host}:${port} through the Gateway Agent (timeout)`))
            }, timeoutMs)
            entry.resolve = resolve
            entry.reject = reject
            send({
                type: 'tcp-open', streamId, host, port,
                ip: nodeConfig.ip, username: nodeConfig.username, password: nodeConfig.password, privateKey: nodeConfig.sshKey
            })
        })
    }

    _onTcpMessage(agentId, msg) {
        const entry = this.tcpStreams.get(msg.streamId)
        // An agent may only feed streams that were opened through IT
        if (!entry || entry.agentId !== agentId) return
        if (msg.type === 'tcp-opened') {
            entry.opened = true
            clearTimeout(entry.timer)
            entry.resolve(entry.duplex)
        } else if (msg.type === 'tcp-data') {
            entry.duplex.push(Buffer.from(msg.data || '', 'base64'))
        } else if (msg.type === 'tcp-close') {
            this.tcpStreams.delete(msg.streamId)
            clearTimeout(entry.timer)
            if (!entry.opened) entry.reject(new Error(msg.error || 'The connection was refused'))
            else entry.duplex.push(null)
        }
    }

    _closeTcpForAgent(agentId, error) {
        for (const [id, entry] of this.tcpStreams) {
            if (entry.agentId !== agentId) continue
            this.tcpStreams.delete(id)
            clearTimeout(entry.timer)
            if (!entry.opened) entry.reject(error)
            else entry.duplex.destroy(error)
        }
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
                err.stdout = result.stdout   // keeps a script's own failure reason
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
