import { NodeSSH } from 'node-ssh'
import { automationEngine } from './automationEngine.js'

// Total verification timeout — must stay under NGINX proxy_read_timeout (300s)
const VERIFY_TIMEOUT_MS = 60_000  // 60s total
// Per-command SSH relay timeout (was 120s — too long for 15+ sequential commands)
const SSH_CMD_TIMEOUT_MS = 15_000  // 15s per command via agent

class NodeVerifier {

    async verifyNode(nodeConfig) {
        // Wrap entire verification in a timeout so we always respond within NGINX limits
        return Promise.race([
            this._doVerify(nodeConfig),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Verification timed out after 60s — check node connectivity')), VERIFY_TIMEOUT_MS)
            )
        ])
    }

    async _doVerify(nodeConfig) {
        const { ip, username, password, sshKey } = nodeConfig

        const result = {
            ip,
            status: 'unknown',
            reachable: false,
            osInfo: null,
            resources: null,
            errors: [],
            warnings: [],
            timestamp: new Date().toISOString()
        }

        try {
            // ── Step 1: SSH connectivity ───────────────────────────────────────────
            let ssh
            try {
                if (nodeConfig.ownerId || nodeConfig.orgId) {
                    ssh = await automationEngine.connectSSH(nodeConfig)
                } else {
                    ssh = new NodeSSH()
                    await ssh.connect({
                        host: ip,
                        username,
                        password: password || undefined,
                        privateKey: sshKey || undefined,
                        timeout: 10000
                    })
                }
                result.reachable = true
                result.status = 'connected'
            } catch (sshError) {
                result.status = 'unreachable'
                result.errors.push(`SSH connection failed: ${sshError.message}`)
                return result
            }

            // Helper: run a command with timeout, never throws
            const run = async (cmd) => {
                try {
                    return await ssh.execCommand(cmd)
                } catch (_) {
                    return { code: 1, stdout: '', stderr: '' }
                }
            }

            // ── Step 2: OS detection ───────────────────────────────────────────────
            try {
                result.osInfo = await this.detectOS(ssh)
                const supported = ['ubuntu', 'debian', 'centos', 'rhel', 'rocky', 'almalinux', 'fedora']
                if (result.osInfo.id && !supported.includes(result.osInfo.id.toLowerCase())) {
                    result.warnings.push(`OS '${result.osInfo.name}' may not be fully supported. Supported: Ubuntu, CentOS, RHEL, Rocky Linux`)
                }
            } catch (osError) {
                result.errors.push(`Failed to detect OS: ${osError.message}`)
            }

            // ── Step 3: System resources ───────────────────────────────────────────
            try {
                result.resources = await this.checkResources(ssh)
                if (result.resources.cpu.cores > 0 && result.resources.cpu.cores < 2) {
                    result.errors.push(`Insufficient CPU cores: ${result.resources.cpu.cores} (minimum 2 required)`)
                }
                if (result.resources.memory.totalGB > 0 && result.resources.memory.totalGB < 2) {
                    result.errors.push(`Insufficient memory: ${result.resources.memory.totalGB}GB (minimum 2GB required)`)
                }
                if (result.resources.disk.freeGB > 0 && result.resources.disk.freeGB < 20) {
                    result.warnings.push(`Low disk space: ${result.resources.disk.freeGB}GB free (20GB+ recommended)`)
                }
                if (result.resources.swap.enabled) {
                    result.warnings.push('Swap is enabled (will be disabled during installation)')
                }
            } catch (resourceError) {
                result.errors.push(`Failed to check resources: ${resourceError.message}`)
            }

            // ── Step 4: Required ports ─────────────────────────────────────────────
            try {
                result.ports = await this.checkPorts(ssh)
                if (result.ports.conflicts.length > 0) {
                    result.warnings.push(`Ports in use: ${result.ports.conflicts.join(', ')}`)
                }
            } catch (portError) {
                result.warnings.push(`Could not check ports: ${portError.message}`)
            }

            // ── Step 5: Internet connectivity ─────────────────────────────────────
            try {
                result.internet = await this.checkInternet(ssh)
                if (!result.internet.connected) {
                    result.errors.push('No internet connectivity detected')
                }
            } catch (internetError) {
                result.warnings.push(`Could not verify internet: ${internetError.message}`)
            }

            // ── Step 6: Existing cluster topology (optional, best-effort) ─────────
            try {
                const topology = await this.checkClusterTopology(ssh)
                if (topology) result.clusterTopology = topology
            } catch (_) { /* optional — ignore */ }

            // ── Final status ───────────────────────────────────────────────────────
            result.status = result.errors.length === 0
                ? (result.warnings.length > 0 ? 'ready-with-warnings' : 'ready')
                : 'not-ready'

            try { ssh.dispose() } catch (_) {}

        } catch (error) {
            result.status = 'error'
            result.errors.push(`Verification failed: ${error.message}`)
        }

        return result
    }

    async detectOS(ssh) {
        const { stdout } = await ssh.execCommand('cat /etc/os-release')
        const osInfo = { id: '', name: '', version: '', versionId: '', prettyName: '' }
        for (const line of (stdout || '').split('\n')) {
            const [key, ...rest] = line.split('=')
            const val = rest.join('=').replace(/"/g, '').trim()
            if (key === 'ID')           osInfo.id         = val
            else if (key === 'NAME')    osInfo.name       = val
            else if (key === 'VERSION_ID') osInfo.versionId = val
            else if (key === 'VERSION') osInfo.version    = val
            else if (key === 'PRETTY_NAME') osInfo.prettyName = val
        }
        return osInfo
    }

    async checkResources(ssh) {
        const resources = {
            cpu:    { cores: 0, model: '' },
            memory: { totalGB: 0, freeGB: 0, usedPercent: 0 },
            disk:   { totalGB: 0, freeGB: 0, usedPercent: 0 },
            swap:   { enabled: false, totalGB: 0 }
        }

        try {
            // CPU
            const cpuR = await ssh.execCommand('nproc')
            resources.cpu.cores = parseInt(cpuR.stdout?.trim()) || 0

            const modelR = await ssh.execCommand("grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2")
            resources.cpu.model = modelR.stdout?.trim() || ''

            // Memory — use -m (MiB) to avoid zero values on small nodes
            const memR = await ssh.execCommand("free -m | awk '/Mem:/ {print $2, $3, $4}'")
            const memP = (memR.stdout?.trim() || '').split(/\s+/)
            const memTotal = parseInt(memP[0]) || 0
            const memUsed  = parseInt(memP[1]) || 0
            const memFree  = parseInt(memP[2]) || 0
            resources.memory.totalGB    = parseFloat((memTotal / 1024).toFixed(1))
            resources.memory.freeGB     = parseFloat((memFree  / 1024).toFixed(1))
            resources.memory.usedPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0

            // Disk — safer parsing with explicit columns
            const diskR = await ssh.execCommand("df -BG / | awk 'NR==2 {print $2, $4, $5}'")
            const diskP = (diskR.stdout?.trim() || '').split(/\s+/)
            resources.disk.totalGB      = parseInt((diskP[0] || '0').replace('G', '')) || 0
            resources.disk.freeGB       = parseInt((diskP[1] || '0').replace('G', '')) || 0
            resources.disk.usedPercent  = parseInt((diskP[2] || '0').replace('%', '')) || 0

            // Swap
            const swapR = await ssh.execCommand('swapon --show 2>/dev/null')
            resources.swap.enabled = (swapR.stdout?.trim().length || 0) > 0
            if (resources.swap.enabled) {
                const swapSR = await ssh.execCommand("free -m | awk '/Swap:/ {print $2}'")
                const swapMB = parseInt(swapSR.stdout?.trim()) || 0
                resources.swap.totalGB = parseFloat((swapMB / 1024).toFixed(1))
            }

            return resources
        } catch (error) {
            throw new Error(`Failed to check resources: ${error.message}`)
        }
    }

    async checkPorts(ssh) {
        const requiredPorts = [6443, 2379, 2380, 10250, 10251, 10252]
        const conflicts = []
        try {
            // Check all ports in a single command to reduce relay round-trips
            const r = await ssh.execCommand(
                `ss -tuln 2>/dev/null | grep -E ':( ${requiredPorts.join('|')})[^0-9]' | awk '{print $5}' | grep -oE '[0-9]+$'`
            )
            for (const port of requiredPorts) {
                if ((r.stdout || '').split('\n').map(s => s.trim()).includes(String(port))) {
                    conflicts.push(port)
                }
            }
            return { required: requiredPorts, conflicts, allAvailable: conflicts.length === 0 }
        } catch (error) {
            throw new Error(`Failed to check ports: ${error.message}`)
        }
    }

    async checkInternet(ssh) {
        try {
            const r = await ssh.execCommand('ping -c 1 -W 3 8.8.8.8 2>/dev/null || curl -s --max-time 3 -o /dev/null -w "%{http_code}" https://registry.k8s.io 2>/dev/null')
            const connected = r.code === 0 || (r.stdout?.trim() === '200')
            const latencyMatch = (r.stdout || '').match(/time=([\d.]+)/)
            return { connected, latency: latencyMatch ? latencyMatch[1] + 'ms' : 'N/A' }
        } catch (_) {
            return { connected: false, latency: 'N/A' }
        }
    }

    async checkClusterTopology(ssh) {
        try {
            const r = await ssh.execCommand(
                "[ -f /etc/kubernetes/admin.conf ] && KUBECONFIG=/etc/kubernetes/admin.conf kubectl get nodes --no-headers -o wide 2>/dev/null | awk '{print $1\"|\"$2\"|\"$3\"|\"$6}' || true"
            )
            const lines = (r.stdout || '').trim().split('\n').filter(Boolean)
            if (!lines.length) return null
            return lines.map(line => {
                const [name, status, roles, ip] = line.split('|')
                return {
                    name,
                    status: status === 'Ready' ? 'Ready' : 'NotReady',
                    role: (roles || '').toLowerCase().includes('control-plane') || (roles || '').toLowerCase().includes('master') ? 'master' : 'worker',
                    ip: ip || 'N/A'
                }
            })
        } catch (_) {
            return null
        }
    }
}

export const nodeVerifier = new NodeVerifier()
