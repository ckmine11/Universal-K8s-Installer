import { Client } from 'ssh2'
import { StringDecoder } from 'string_decoder'
import { agentService } from './agentService.js'
import { assertDirectConnectAllowed } from '../utils/netGuard.js'
import { terminalAccess, terminalRecorder } from './terminalAccess.js'

// An interactive shell on ONE node, in the browser (xterm ⇄ WebSocket ⇄ SSH).
// The SSH connection runs over a TCP stream into the cluster's network —
// through the Gateway Agent when the workspace has one, otherwise through the
// node itself — like every other KubeEZ connection to the nodes.
// Access: terminal:access + a current just-in-time grant for the cluster.
// The output is recorded (what a person sees, incl. the echoed commands —
// keystrokes are not stored, so passwords typed at a prompt never are).

const GRANT_CHECK_MS = 15000

export async function openNodeShell({ ws, user, cluster, nodeIp, cols = 120, rows = 32, ip }) {
    const send = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)) }
    const node = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])].find(n => n.ip === nodeIp)
    if (!node) { send({ type: 'error', message: 'This node is not part of the cluster.' }); return ws.close(4004, 'Unknown node') }
    let grant = terminalAccess.activeGrant(user.id, cluster.id)
    if (!grant) { send({ type: 'access-required', message: 'No current terminal access for this cluster.' }); return ws.close(4003, 'Access required') }

    let conn, stream, recording = null, closed = false
    const close = (why) => {
        if (closed) return
        closed = true
        clearInterval(timer)
        try { stream?.end() } catch { }
        try { conn?.end() } catch { }
        if (recording) terminalRecorder.end(recording, why)
        if (ws.readyState === 1) ws.close(1000, why.slice(0, 100))
    }
    // the grant can end (time limit, an admin ends it) while the shell is open
    const timer = setInterval(() => {
        grant = terminalAccess.activeGrant(user.id, cluster.id)
        if (!grant) { send({ type: 'output', data: '\r\n\x1b[1;31m[KubeEZ] Terminal access ended — the session is closed.\x1b[0m\r\n' }); close('access ended') }
    }, GRANT_CHECK_MS)
    timer.unref?.()
    ws.on('close', () => close('closed'))

    try {
        const port = Number(node.port) || 22
        const opts = {
            username: node.username || 'root', password: node.password || undefined, privateKey: node.sshKey || undefined,
            readyTimeout: 20000, keepaliveInterval: 15000
        }
        // Like every other connection: through the Gateway Agent when the workspace has
        // one online (a TCP stream via the agent's SSH session to this node), else directly
        const agent = await agentService.getGatewayAgentForOwner(cluster.ownerId, 'admin', cluster.orgId)
        if (agent) opts.sock = await agentService.openTcp(agent.agentId, { ...node, ownerId: cluster.ownerId, orgId: cluster.orgId }, '127.0.0.1', port)
        else { await assertDirectConnectAllowed(node.ip); opts.host = node.ip; opts.port = port }
        conn = new Client()
        await new Promise((resolve, reject) => {
            conn.on('ready', resolve).on('error', reject)
            conn.connect(opts)
        })
        stream = await new Promise((resolve, reject) => conn.shell({ term: 'xterm-256color', cols, rows }, (e, s) => e ? reject(e) : resolve(s)))
    } catch (e) {
        const hint = /Channel open failure|administratively prohibited/i.test(e.message)
            ? ' — the node does not allow SSH port forwarding (AllowTcpForwarding no in /etc/ssh/sshd_config), which shells through the Gateway Agent need.' : ''
        send({ type: 'error', message: `Could not open a shell on ${node.ip}: ${e.message}${hint}` })
        return close('could not connect')
    }
    if (closed) return close('closed')

    recording = terminalRecorder.start({
        orgId: cluster.orgId || null, clusterId: cluster.id, clusterName: cluster.clusterName,
        user: { id: user.id, username: user.username, role: user.role }, grantId: grant.id, reason: grant.reason, ip,
        node: node.ip, mode: 'shell'
    })
    send({ type: 'ready', node: node.ip, expiresAt: grant.expiresAt })
    const decoder = new StringDecoder('utf8')
    const out = (chunk) => {
        const text = decoder.write(chunk)
        if (!text) return
        terminalRecorder.output(recording, node.ip, 'shell', text)
        send({ type: 'output', data: text })
    }
    stream.on('data', out)
    stream.stderr?.on('data', out)
    stream.on('close', () => close('shell exited'))
    conn.on('close', () => close('connection closed'))
    conn.on('error', () => close('connection error'))

    ws.on('message', (raw) => {
        let m
        try { m = JSON.parse(raw) } catch { return }
        if (m.type === 'input' && typeof m.data === 'string') stream.write(m.data)
        else if (m.type === 'resize') {
            const c = Math.max(20, Math.min(500, Number(m.cols) || 0)), r = Math.max(5, Math.min(200, Number(m.rows) || 0))
            if (c && r) stream.setWindow(r, c, 0, 0)
        }
    })
}
