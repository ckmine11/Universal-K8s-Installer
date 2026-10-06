import crypto from 'crypto'
import { automationEngine } from './automationEngine.js'
import { agentService } from './agentService.js'

const IDLE_MS = 5 * 60 * 1000

/**
 * TCP streams into a cluster's network, as seen from its first control-plane:
 * through the Gateway Agent when the workspace has one online, otherwise
 * through a pooled direct SSH connection (port forwarding over SSH). Nothing
 * in the cluster needs an open port.
 */
class ClusterTunnel {
    constructor() {
        this.pool = new Map()   // key → { ssh, timer, connecting }
    }

    node(cluster) {
        const m = cluster.masterNodes?.[0]
        if (!m) throw new Error('This cluster has no control-plane node')
        return { ...m, ownerId: cluster.ownerId, orgId: cluster.orgId }
    }

    _key(n) {
        return crypto.createHash('sha256').update([n.ip, n.username, n.password || '', n.sshKey || ''].join('\0')).digest('hex')
    }

    async _direct(node) {
        const key = this._key(node)
        let e = this.pool.get(key)
        if (e?.ssh?.isConnected?.()) { this._touch(key); return e.ssh }
        if (e?.connecting) return e.connecting
        const connecting = automationEngine.connectSSH(node).then(ssh => {
            this.pool.set(key, { ssh })
            ssh.connection?.on?.('close', () => { if (this.pool.get(key)?.ssh === ssh) this.pool.delete(key) })
            this._touch(key)
            return ssh
        }).catch(err => { this.pool.delete(key); throw err })
        this.pool.set(key, { connecting })
        return connecting
    }

    _touch(key) {
        const e = this.pool.get(key)
        if (!e) return
        clearTimeout(e.timer)
        e.timer = setTimeout(() => { try { e.ssh?.dispose?.() } catch { } this.pool.delete(key) }, IDLE_MS)
        e.timer.unref?.()
    }

    /** A Duplex connected to host:port inside the cluster. */
    async open(cluster, host, port) {
        const node = this.node(cluster)
        const agent = await agentService.getGatewayAgentForOwner(node.ownerId, 'admin', node.orgId)
        if (agent) return agentService.openTcp(agent.agentId, node, host, port)

        const ssh = await this._direct(node)
        if (typeof ssh.forwardOut !== 'function') throw new Error('This connection cannot forward TCP')
        try {
            return await ssh.forwardOut('127.0.0.1', 0, host, port)
        } catch (err) {
            // a pooled connection that died quietly — one fresh attempt
            this.pool.delete(this._key(node))
            try { ssh.dispose?.() } catch { }
            const fresh = await this._direct(node)
            return fresh.forwardOut('127.0.0.1', 0, host, port)
        }
    }
}

export const clusterTunnel = new ClusterTunnel()
