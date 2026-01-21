import { NodeSSH } from 'node-ssh'

class NodeVerifier {
    async verifyNode(nodeConfig) {
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
            // Step 1: Test SSH connectivity
            const ssh = new NodeSSH()

            try {
                await ssh.connect({
                    host: ip,
                    username,
                    password: password || undefined,
                    privateKey: sshKey || undefined,
                    timeout: 10000
                })

                result.reachable = true
                result.status = 'connected'
            } catch (sshError) {
                result.status = 'unreachable'
                result.errors.push(`SSH connection failed: ${sshError.message}`)
                return result
            }

            // Step 2: Detect OS type and version
            try {
                const osInfo = await this.detectOS(ssh)
                result.osInfo = osInfo

                // Check if OS is supported
                const supportedOS = ['ubuntu', 'centos', 'rhel', 'rocky', 'almalinux']
                if (!supportedOS.includes(osInfo.id.toLowerCase())) {
                    result.warnings.push(`OS '${osInfo.name}' may not be fully supported. Supported: Ubuntu, CentOS, RHEL, Rocky Linux`)
                }
            } catch (osError) {
                result.errors.push(`Failed to detect OS: ${osError.message}`)
            }

            // Step 3: Check system resources
            try {
                const resources = await this.checkResources(ssh)
                result.resources = resources

                // Validate minimum requirements
                if (resources.cpu.cores < 2) {
                    result.errors.push(`Insufficient CPU cores: ${resources.cpu.cores} (minimum 2 required)`)
                }

                if (resources.memory.totalGB < 2) {
                    result.errors.push(`Insufficient memory: ${resources.memory.totalGB}GB (minimum 2GB required)`)
                }

                if (resources.disk.freeGB < 20) {
                    result.warnings.push(`Low disk space: ${resources.disk.freeGB}GB free (20GB+ recommended)`)
                }

                if (resources.swap.enabled) {
                    result.warnings.push('Swap is enabled (will be disabled during installation)')
                }
            } catch (resourceError) {
                result.errors.push(`Failed to check resources: ${resourceError.message}`)
            }

            // Step 4: Check required ports (for master nodes)
            try {
                const portCheck = await this.checkPorts(ssh)
                result.ports = portCheck

                if (portCheck.conflicts.length > 0) {
                    result.warnings.push(`Ports in use: ${portCheck.conflicts.join(', ')}`)
                }
            } catch (portError) {
                result.warnings.push(`Could not check ports: ${portError.message}`)
            }

            // Step 5: Check internet connectivity
            try {
                const internetCheck = await this.checkInternet(ssh)
                result.internet = internetCheck

                if (!internetCheck.connected) {
                    result.errors.push('No internet connectivity detected')
                }
            } catch (internetError) {
                result.warnings.push(`Could not verify internet: ${internetError.message}`)
            }

            // Step 6: Check Cluster Topology (for existing masters)
            try {
                const topology = await this.checkClusterTopology(ssh)
                if (topology) {
                    result.clusterTopology = topology
                }
            } catch (topoError) {
                console.warn('Topology check skip:', topoError.message)
            }

            // Determine final status
            if (result.errors.length === 0) {
                result.status = result.warnings.length > 0 ? 'ready-with-warnings' : 'ready'
            } else {
                result.status = 'not-ready'
            }

            // Cleanup
            ssh.dispose()

        } catch (error) {
            result.status = 'error'
            result.errors.push(`Verification failed: ${error.message}`)
        }

        return result
    }

    async detectOS(ssh) {
        try {
            const { stdout } = await ssh.execCommand('cat /etc/os-release')

            const osInfo = {
                id: '',
                name: '',
                version: '',
                versionId: '',
                prettyName: ''
            }

            // Parse os-release file
            const lines = stdout.split('\n')
            for (const line of lines) {
                if (line.startsWith('ID=')) {
                    osInfo.id = line.split('=')[1].replace(/"/g, '')
                } else if (line.startsWith('NAME=')) {
                    osInfo.name = line.split('=')[1].replace(/"/g, '')
                } else if (line.startsWith('VERSION_ID=')) {
                    osInfo.versionId = line.split('=')[1].replace(/"/g, '')
                } else if (line.startsWith('VERSION=')) {
                    osInfo.version = line.split('=')[1].replace(/"/g, '')
                } else if (line.startsWith('PRETTY_NAME=')) {
                    osInfo.prettyName = line.split('=')[1].replace(/"/g, '')
                }
            }

            return osInfo
        } catch (error) {
            throw new Error(`Failed to detect OS: ${error.message}`)
        }
    }

    async checkResources(ssh) {
        const resources = {
            cpu: { cores: 0, model: '' },
            memory: { totalGB: 0, freeGB: 0, usedPercent: 0 },
            disk: { totalGB: 0, freeGB: 0, usedPercent: 0 },
            swap: { enabled: false, totalGB: 0 }
        }

        try {
            // CPU info
            const cpuResult = await ssh.execCommand('nproc')
            resources.cpu.cores = parseInt(cpuResult.stdout.trim())

            const cpuModelResult = await ssh.execCommand('cat /proc/cpuinfo | grep "model name" | head -1 | cut -d: -f2')
            resources.cpu.model = cpuModelResult.stdout.trim()

            // Memory info
            const memResult = await ssh.execCommand('free -g | grep Mem')
            const memParts = memResult.stdout.trim().split(/\s+/)
            resources.memory.totalGB = parseInt(memParts[1])
            resources.memory.freeGB = parseInt(memParts[3])
            resources.memory.usedPercent = Math.round((parseInt(memParts[2]) / parseInt(memParts[1])) * 100)

            // Disk info
            const diskResult = await ssh.execCommand('df -BG / | tail -1')
            const diskParts = diskResult.stdout.trim().split(/\s+/)
            resources.disk.totalGB = parseInt(diskParts[1].replace('G', ''))
            resources.disk.freeGB = parseInt(diskParts[3].replace('G', ''))
            resources.disk.usedPercent = parseInt(diskParts[4].replace('%', ''))

            // Swap info
            const swapResult = await ssh.execCommand('swapon --show')
            resources.swap.enabled = swapResult.stdout.trim().length > 0
            if (resources.swap.enabled) {
                const swapSizeResult = await ssh.execCommand('free -g | grep Swap')
                const swapParts = swapSizeResult.stdout.trim().split(/\s+/)
                resources.swap.totalGB = parseInt(swapParts[1])
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
            for (const port of requiredPorts) {
                const result = await ssh.execCommand(`ss -tuln | grep :${port}`)
                if (result.stdout.trim().length > 0) {
                    conflicts.push(port)
                }
            }

            return {
                required: requiredPorts,
                conflicts,
                allAvailable: conflicts.length === 0
            }
        } catch (error) {
            throw new Error(`Failed to check ports: ${error.message}`)
        }
    }

    async checkInternet(ssh) {
        try {
            const result = await ssh.execCommand('ping -c 1 -W 2 8.8.8.8')
            return {
                connected: result.code === 0,
                latency: result.stdout.includes('time=') ? result.stdout.match(/time=([\d.]+)/)[1] + 'ms' : 'N/A'
            }
        } catch (error) {
            return {
                connected: false,
                error: error.message
            }
        }
    }

    async checkClusterTopology(ssh) {
        try {
            // Use a highly robust format with a pipe separator to avoid parsing ambiguity
            const cmd = `if [ -f /etc/kubernetes/admin.conf ]; then export KUBECONFIG=/etc/kubernetes/admin.conf && kubectl get nodes --no-headers -o custom-columns="NAME:.metadata.name,STATUS:.status.conditions[?(@.type=='Ready')].status,ROLES:.metadata.labels,IP:.status.addresses[?(@.type=='InternalIP')].address" | tr -s ' ' | sed 's/ /|/g'; fi`
            const result = await ssh.execCommand(cmd)

            if (result.stdout.trim()) {
                const lines = result.stdout.trim().split('\n')
                return lines.map(line => {
                    const parts = line.split('|')
                    const name = parts[0]
                    const status = parts[1] === 'True' ? 'Ready' : 'NotReady'
                    const labels = (parts[2] || '').toLowerCase()
                    const ip = parts[3] || 'N/A'
                    const isMaster = labels.includes('control-plane') || labels.includes('master')
                    return { name, status, role: isMaster ? 'master' : 'worker', ip }
                })
            }
            return null
        } catch (error) {
            console.error('Topology discovery error:', error.message)
            return null
        }
    }
}

export const nodeVerifier = new NodeVerifier()
