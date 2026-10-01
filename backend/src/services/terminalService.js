import { automationEngine } from './automationEngine.js';

/**
 * Orbital Terminal SSH sessions.
 *
 * Sessions are keyed by a per-WebSocket-connection id (never by a
 * client-supplied clusterId), and the nodes always come from the server-side
 * cluster record — callers must pass nodes they loaded and authorized.
 */
class TerminalService {
    constructor() {
        this.sessions = new Map(); // sessionKey -> Map(nodeIp -> ssh)
    }

    async getConnection(sessionKey, node) {
        if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, new Map());
        const nodeSessions = this.sessions.get(sessionKey);
        if (!nodeSessions.has(node.ip)) {
            // Routes through the tenant's Gateway Agent when one is online
            nodeSessions.set(node.ip, await automationEngine.connectSSH(node));
        }
        return nodeSessions.get(node.ip);
    }

    async broadcastCommand(sessionKey, nodes, command, onOutput) {
        await Promise.all(nodes.map(async (node) => {
            const ip = node.ip;
            let ssh;
            try {
                ssh = await this.getConnection(sessionKey, node);
            } catch (err) {
                console.error(`[Terminal] Failed to connect to ${ip}:`, err.message);
                onOutput(ip, 'error', `Connection failed: Unable to authenticate with ${ip}. Check credentials.`);
                return;
            }

            try {
                await ssh.execCommand(command, {
                    onStdout: (chunk) => onOutput(ip, 'stdout', chunk.toString()),
                    onStderr: (chunk) => onOutput(ip, 'stderr', chunk.toString())
                });
            } catch (err) {
                onOutput(ip, 'error', err.message);
            }
        }));
    }

    async closeSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (session) {
            for (const ssh of session.values()) {
                try { ssh.dispose?.(); } catch (_) { /* ignore */ }
            }
            this.sessions.delete(sessionKey);
        }
    }
}

export const terminalService = new TerminalService();
