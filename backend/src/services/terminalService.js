import { NodeSSH } from 'node-ssh';
import { decrypt } from '../utils/cryptoUtils.js';

class TerminalService {
    constructor() {
        this.sessions = new Map(); // clusterId -> { nodeIp -> ssh }
    }

    async getSession(clusterId, nodes) {
        if (!this.sessions.has(clusterId)) {
            const nodeSessions = new Map();
            for (const node of nodes) {
                const ssh = new NodeSSH();
                try {
                    await ssh.connect({
                        host: node.ip,
                        username: node.username || 'root',
                        password: node.password ? decrypt(node.password) : undefined,
                        privateKey: node.sshKey ? decrypt(node.sshKey) : node.privateKeyPath
                    });
                    nodeSessions.set(node.ip, ssh);
                } catch (err) {
                    console.error(`Failed to connect to ${node.ip}:`, err);
                }
            }
            this.sessions.set(clusterId, nodeSessions);
        }
        return this.sessions.get(clusterId);
    }

    async broadcastCommand(clusterId, nodes, command, onOutput) {
        const session = await this.getSession(clusterId, nodes);
        const promises = nodes.map(async (node) => {
            const ip = node.ip;
            const ssh = session.get(ip);

            if (!ssh) {
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
        });
        await Promise.all(promises);
    }

    async closeSession(clusterId) {
        const session = this.sessions.get(clusterId);
        if (session) {
            for (const ssh of session.values()) {
                ssh.dispose();
            }
            this.sessions.delete(clusterId);
        }
    }
}

export const terminalService = new TerminalService();
