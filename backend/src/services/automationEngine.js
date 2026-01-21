import { NodeSSH } from 'node-ssh'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

class AutomationEngine {
    constructor() {
        this.simulationMode = false
    }

    async executeScript(ssh, scriptPath, args = [], onLog) {
        try {
            // Read script content
            const scriptContent = readFileSync(scriptPath, 'utf8')

            // Upload script to remote node
            const remotePath = `/tmp/kubeez-${Date.now()}.sh`
            await ssh.execCommand(`cat > ${remotePath} << 'EOFSCRIPT'\n${scriptContent}\nEOFSCRIPT`)
            await ssh.execCommand(`chmod +x ${remotePath}`)

            onLog('info', `Script execution started: ${scriptPath.split(/[\\/]/).pop()}`)

            // Execute script with correctly quoted arguments and streaming logs
            const quotedArgs = args.map(arg => `'${String(arg).replace(/'/g, "'\\''")}'`).join(' ')

            const result = await ssh.execCommand(`sudo bash ${remotePath} ${quotedArgs}`, {
                onStdout: (chunk) => {
                    const lines = chunk.toString('utf8').split('\n')
                    lines.forEach(line => {
                        if (line.trim()) onLog('info', line)
                    })
                },
                onStderr: (chunk) => {
                    const lines = chunk.toString('utf8').split('\n')
                    lines.forEach(line => {
                        if (line.trim()) {
                            // Don't treat all stderr as warnings (yum/apt use it for progress)
                            if (line.includes('warning') || line.includes('Error') || line.includes('fail')) {
                                onLog('warning', line)
                            } else {
                                onLog('info', line)
                            }
                        }
                    })
                }
            })

            // Cleanup
            await ssh.execCommand(`rm -f ${remotePath}`)

            if (result.code !== 0) {
                // INTELLIGENT ERROR ANALYSIS
                // Capture the last few lines of stderr for context
                const errorContext = result.stderr.slice(-500) // Last 500 chars
                const analysis = this.analyzeError(errorContext)

                const enrichedError = new Error(`Script execution failed with code ${result.code}`)
                enrichedError.code = result.code
                enrichedError.diagnosis = analysis
                enrichedError.stderr = result.stderr
                throw enrichedError
            }

            return result
        } catch (error) {
            // Pass through our enriched error if it exists
            if (error.diagnosis) throw error;
            throw new Error(`Failed to execute script: ${error.message}`)
        }
    }

    analyzeError(stderr) {
        const errorLog = stderr.toLowerCase()

        if (errorLog.includes('could not get lock') || errorLog.includes('resource temporarily unavailable')) {
            return {
                reason: 'Package Manager Locked',
                message: 'Another process is using apt/dpkg. This often happens if an auto-update is running in background.',
                suggestedFix: 'Kill background apt processes and remove lock files.',
                fixAction: 'fix_dpkg_lock'
            }
        }

        if (errorLog.includes('running with swap on is not supported')) {
            return {
                reason: 'Swap Memory Enabled',
                message: 'Kubernetes requires swap memory to be disabled, but swap is currently active.',
                suggestedFix: 'Disable swap immediately.',
                fixAction: 'fix_swap_off'
            }
        }

        if (errorLog.includes('port 6443 is already in use') || errorLog.includes('address already in use')) {
            return {
                reason: 'Port Conflict',
                message: 'Port 6443 is already in use. A previous partial installation might be running.',
                suggestedFix: 'Reset Kubernetes configuration and kill conflicting processes.',
                fixAction: 'fix_kube_reset'
            }
        }

        if (errorLog.includes('connection timed out') || errorLog.includes('connection refused')) {
            return {
                reason: 'Network Timeout',
                message: 'SSH or Network connection timed out. Firewall might be blocking keys.',
                suggestedFix: 'Retry connection and check Firewall settings.',
                fixAction: 'retry_connection'
            }
        }

        return {
            reason: 'Unknown execution error',
            message: 'An unexpected script error occurred.',
            suggestedFix: 'Review logs and Retry Step.',
            fixAction: 'retry_step'
        }
    }

    async runFix(fixAction, node, onLog) {
        onLog('info', `👨‍⚕️ Auto-Doctor: Executing fix for ${fixAction} on ${node.ip}...`)
        const ssh = await this.connectSSH(node)

        try {
            if (fixAction === 'fix_dpkg_lock') {
                await ssh.execCommand('sudo killall apt apt-get 2>/dev/null || true')
                await ssh.execCommand('sudo rm /var/lib/apt/lists/lock 2>/dev/null || true')
                await ssh.execCommand('sudo rm /var/cache/apt/archives/lock 2>/dev/null || true')
                await ssh.execCommand('sudo rm /var/lib/dpkg/lock* 2>/dev/null || true')
                await ssh.execCommand('sudo dpkg --configure -a') // Repair db
                onLog('success', '✓ Package manager locks removed and DB repaired.')
            }
            else if (fixAction === 'fix_swap_off') {
                await ssh.execCommand('sudo swapoff -a')
                await ssh.execCommand("sudo sed -i '/ swap / s/^\\(.*\\)$/#\\1/g' /etc/fstab")
                onLog('success', '✓ Swap disabled successfully.')
            }
            else if (fixAction === 'fix_kube_reset') {
                await ssh.execCommand('sudo kubeadm reset -f || true')
                await ssh.execCommand('sudo rm -rf /etc/cni/net.d')
                await ssh.execCommand('sudo rm -rf $HOME/.kube/config')
                onLog('success', '✓ Kubernetes state reset. Ready for clean install.')
            }
            else {
                onLog('info', 'ℹ No specific script for this fix. Just retrying connection/step.')
            }

            return true
        } catch (err) {
            onLog('error', `❌ Auto-Fix failed: ${err.message}`)
            throw err
        } finally {
            ssh.dispose()
        }
    }

    async connectSSH(node) {
        const ssh = new NodeSSH()
        await ssh.connect({
            host: node.ip,
            username: node.username,
            password: node.password,
            privateKey: node.sshKey || undefined,
            readyTimeout: 30000
        })
        return ssh
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    async install(installation, callbacks) {
        const { onLog, onProgress, onComplete, onError } = callbacks

        try {
            onLog('info', '🚀 Starting Kubernetes cluster installation...')
            onProgress(0, 'Initializing installation process')

            // Try to detect if we have real nodes
            const hasRealNodes = await this.detectRealNodes(installation, onLog)

            if (!hasRealNodes) {
                onLog('warning', '⚠️ No real nodes detected - Running in SIMULATION mode')
                onLog('warning', '⚠️ To use real installation, provide actual Linux machines with SSH access')
                this.simulationMode = true
            }

            // Step 1: Validate connectivity
            onProgress(5, 'Validating node connectivity...')
            await this.validateConnectivity(installation, onLog)

            // Step 1.5: Pre-flight checks
            onProgress(8, 'Running pre-flight checks...')
            await this.preFlightChecks(installation, onLog)

            // Step 2: Configure Firewall
            onProgress(12, 'Configuring firewall rules...')
            await this.configureFirewall(installation, onLog)

            // Step 2b: Brute Force Time Sync (Master as Source of Truth)
            onProgress(15, 'Force-Syncing clocks and hostnames...')
            const masterNode = installation.masterNodes[0]
            const masterSsh = await this.connectSSH(masterNode)
            const timeResult = await masterSsh.execCommand('date +"%m%d%H%M%Y.%S"')
            const masterTime = timeResult.stdout.trim()
            masterSsh.dispose()

            const allNodes = [...installation.masterNodes, ...(installation.workerNodes || [])]
            const hostsEntries = allNodes.map(n => {
                const hn = n.hostname || `node-${n.ip.replace(/\./g, '-')}`
                return `${n.ip} ${hn}`
            }).join('\n')

            for (const node of allNodes) {
                const nodeSsh = await this.connectSSH(node)
                // Idempotent host sync & Kernel Persistence
                const syncCmd = `sudo bash -c '
                    # Clean previous entries and add new ones
                    sed -i "/# KubeEZ Managed/d" /etc/hosts
                    echo "# KubeEZ Managed Start" >> /etc/hosts
                    echo "${hostsEntries}" >> /etc/hosts
                    echo "# KubeEZ Managed End" >> /etc/hosts
                    
                    # Persist kernel modules across reboots
                    echo -e "overlay\nbr_netfilter" > /etc/modules-load.d/k8s.conf
                    modprobe overlay && modprobe br_netfilter

                    # Set date from Master
                    date "${masterTime}" || true
                    hwclock -w || true
                    
                    # SELinux Hardening (Permissive)
                    [ -f /etc/sysconfig/selinux ] && sed -i "s/^SELINUX=enforcing/SELINUX=permissive/" /etc/sysconfig/selinux || true
                    [ -f /etc/selinux/config ] && sed -i "s/^SELINUX=enforcing/SELINUX=permissive/" /etc/selinux/config || true
                    command -v setenforce &> /dev/null && setenforce 0 || true
                '`
                await nodeSsh.execCommand(syncCmd)
                nodeSsh.dispose()
            }

            // Step 3: Install container runtime
            onProgress(20, 'Installing container runtime (containerd)...')
            await this.installContainerRuntime(installation, onLog)

            // Step 4: Install Kubernetes components
            onProgress(35, 'Installing kubeadm, kubelet, kubectl...')
            await this.installKubernetesComponents(installation, onLog)

            // Step 5: Initialize control plane
            onProgress(50, 'Initializing Kubernetes control plane...')
            const joinCommand = await this.initializeControlPlane(installation, onLog)

            // Step 6: Install network plugin
            if (installation.mode === 'scale') {
                onLog('info', 'Scaling Mode: Skipping network plugin installation (Cluster already configured)')
            } else {
                onProgress(65, 'Installing network plugin...')
                await this.installNetworkPlugin(installation, onLog)
            }

            // Step 7: Join additional Master and Worker nodes
            onProgress(75, 'Joining nodes to cluster...')
            await this.joinNodes(installation, joinCommand, onLog)

            // Step 8: Install add-ons (Skip in Scale mode as they are cluster-wide)
            if (installation.mode === 'scale') {
                onLog('info', '⏭️ Scaling Mode: Skipping add-on installation (Cluster already configured)')
            } else {
                onProgress(85, 'Installing add-ons...')
                await this.installAddons(installation, onLog)
            }

            // Step 9: Post-installation validation
            onProgress(95, 'Running cluster validation...')
            await this.postInstallationValidation(installation, onLog)

            // Complete
            onProgress(100, 'Installation completed successfully!')

            if (this.simulationMode) {
                onLog('warning', '⚠️ SIMULATION MODE - No real cluster was created')
                onLog('info', '💡 To create a real cluster, provide actual Linux machines with SSH access')
            } else {
                onLog('success', '✅ Kubernetes cluster is ready!')
            }


            const clusterInfo = {
                name: installation.clusterName,
                version: installation.k8sVersion,
                nodes: [
                    ...installation.masterNodes.map(n => ({
                        name: n.hostname || `master-${n.ip.replace(/\./g, '-')}`,
                        ip: n.ip,
                        role: 'master',
                        status: 'Ready'
                    })),
                    ...(installation.workerNodes || []).map(n => ({
                        name: n.hostname || `worker-${n.ip.replace(/\./g, '-')}`,
                        ip: n.ip,
                        role: 'worker',
                        status: 'Ready'
                    }))
                ],
                nodeCount: installation.masterNodes.length + (installation.workerNodes?.length || 0),
                endpoint: `https://${installation.masterNodes[0].ip}:6443`,
                simulationMode: this.simulationMode
            }

            onComplete(clusterInfo)

        } catch (error) {
            onLog('error', `❌ Installation failed: ${error.message}`)
            onError(error)
        }
    }

    async detectRealNodes(installation, onLog) {
        // Try to connect to first master node
        const masterNode = installation.masterNodes[0]

        if (!masterNode || !masterNode.ip || !masterNode.username) {
            onLog('warning', '⚠️ Missing node configuration (IP/User)')
            return false
        }

        onLog('info', `Testing connection to master node: ${masterNode.ip}...`)

        try {
            const ssh = await this.connectSSH(masterNode)
            ssh.dispose()
            onLog('success', '✓ Connection test successful')
            return true
        } catch (error) {
            onLog('warning', `⚠️ Connection test failed: ${error.message}`)
            onLog('warning', `DEBUG Info: IP=${masterNode.ip}, User=${masterNode.username}, PwdLength=${masterNode.password ? masterNode.password.length : 0}`)
            return false
        }
    }

    async validateConnectivity(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Checking SSH connectivity to all nodes...')
            await this.sleep(1000)

            const allNodes = [
                ...installation.masterNodes.map(n => ({ ...n, type: 'master' })),
                ...(installation.workerNodes || []).map(n => ({ ...n, type: 'worker' }))
            ]

            for (const node of allNodes) {
                onLog('success', `[SIMULATION] ✓ Connected to ${node.type} node: ${node.ip}`)
            }
            return
        }

        onLog('info', 'Checking SSH connectivity to all nodes...')

        const allNodes = [
            ...installation.masterNodes.map(n => ({ ...n, type: 'master' })),
            ...(installation.workerNodes || []).map(n => ({ ...n, type: 'worker' }))
        ]

        for (const node of allNodes) {
            try {
                const ssh = await this.connectSSH(node)

                // Get OS info
                const osInfo = await ssh.execCommand('cat /etc/os-release')
                const osMatch = osInfo.stdout.match(/ID=["']?([^"\n]+)["']?/)
                const osType = osMatch ? osMatch[1] : 'unknown'

                onLog('success', `✓ Connected to ${node.type} node: ${node.ip} (${osType})`)
                ssh.dispose()
            } catch (error) {
                throw new Error(`Failed to connect to ${node.type} node ${node.ip}: ${error.message}`)
            }
        }
    }

    async configureFirewall(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Configuring firewall rules on all nodes...')
            await this.sleep(1000)
            onLog('success', '[SIMULATION] ✓ Firewall rules configured')
            return
        }

        onLog('info', 'Configuring firewall rules on all nodes...')

        const allNodes = [
            ...installation.masterNodes.map(n => ({ ...n, type: 'master' })),
            ...(installation.workerNodes || []).map(n => ({ ...n, type: 'worker' }))
        ]

        const scriptPath = join(__dirname, '../automation/configure-firewall.sh')

        for (const node of allNodes) {
            const ssh = await this.connectSSH(node)
            onLog('info', `Configuring firewall on ${node.type} node: ${node.ip}`)

            try {
                await this.executeScript(ssh, scriptPath, [node.type], onLog)
                onLog('success', `✓ Firewall configured for ${node.ip}`)
            } finally {
                ssh.dispose()
            }
        }
    }

    async preFlightChecks(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Running pre-flight checks on all nodes...')
            await this.sleep(1500)
            onLog('success', '[SIMULATION] ✓ All pre-flight checks passed')
            return
        }

        onLog('info', 'Running pre-flight checks on all nodes...')

        const scriptPath = join(__dirname, '../automation/preflight-checks.sh')

        for (const node of installation.masterNodes) {
            const ssh = await this.connectSSH(node)
            try {
                const hostnameResult = await ssh.execCommand('hostname')
                node.hostname = hostnameResult.stdout.trim()
                await this.executeScript(ssh, scriptPath, [], onLog)
                onLog('success', `✓ Pre-flight checks passed for master: ${node.ip} (${node.hostname})`)
            } finally { ssh.dispose() }
        }

        for (const node of (installation.workerNodes || [])) {
            const ssh = await this.connectSSH(node)
            try {
                const hostnameResult = await ssh.execCommand('hostname')
                node.hostname = hostnameResult.stdout.trim()
                await this.executeScript(ssh, scriptPath, [], onLog)
                onLog('success', `✓ Pre-flight checks passed for worker: ${node.ip} (${node.hostname})`)
            } finally { ssh.dispose() }
        }
    }

    async installContainerRuntime(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Installing containerd on all nodes...')
            await this.sleep(2000)
            onLog('success', '[SIMULATION] ✓ containerd installed successfully')
            return
        }

        onLog('info', 'Installing containerd on all nodes...')

        let allNodes = [
            ...installation.masterNodes.map(n => ({ ...n, type: 'master' })),
            ...(installation.workerNodes || []).map(n => ({ ...n, type: 'worker' }))
        ]

        if (installation.mode === 'scale') {
            onLog('info', 'Scaling Mode: Skipping Bridge Master for runtime installation')
            allNodes = allNodes.slice(1)
        }

        const scriptPath = join(__dirname, '../automation/install-containerd.sh')

        for (const node of allNodes) {
            const ssh = await this.connectSSH(node)
            onLog('info', `Installing containerd on ${node.type} node: ${node.ip}`)

            try {
                await this.executeScript(ssh, scriptPath, [], onLog)
                onLog('success', `✓ containerd installed on ${node.ip}`)
            } finally {
                ssh.dispose()
            }
        }
    }

    async installKubernetesComponents(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Installing Kubernetes components...')
            await this.sleep(2500)
            onLog('success', '[SIMULATION] ✓ kubeadm, kubelet, kubectl installed')
            return
        }

        onLog('info', 'Installing Kubernetes components on all nodes...')

        let allNodes = [
            ...installation.masterNodes.map(n => ({ ...n, type: 'master' })),
            ...(installation.workerNodes || []).map(n => ({ ...n, type: 'worker' }))
        ]

        if (installation.mode === 'scale') {
            onLog('info', 'Scaling Mode: Skipping Bridge Master for K8s components')
            allNodes = allNodes.slice(1)
        }

        const scriptPath = join(__dirname, '../automation/install-kubernetes.sh')
        const k8sVersion = installation.k8sVersion.split('.').slice(0, 2).join('.') // e.g., "1.28.0" -> "1.28"

        for (const node of allNodes) {
            const ssh = await this.connectSSH(node)
            onLog('info', `Installing Kubernetes v${k8sVersion} on ${node.type} node: ${node.ip}`)

            try {
                await this.executeScript(ssh, scriptPath, [k8sVersion], onLog)
                onLog('success', `✓ Kubernetes components installed on ${node.ip}`)
            } finally {
                ssh.dispose()
            }
        }
    }

    async initializeControlPlane(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Initializing Kubernetes control plane...')
            const masterNode = installation.masterNodes[0]
            onLog('info', `[SIMULATION] Control plane endpoint: ${masterNode.ip}:6443`)
            await this.sleep(2000)
            onLog('success', '[SIMULATION] ✓ Control plane initialized')
            onLog('info', `Cluster endpoint: https://${masterNode.ip}:6443`)
            return 'kubeadm join 192.168.1.10:6443 --token abc123.xyz789 --discovery-token-ca-cert-hash sha256:1234567890abcdef'
        }

        onLog('info', installation.mode === 'scale' ? 'Preparing cluster for scaling...' : 'Initializing Kubernetes control plane...')

        const masterNode = installation.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)

        let scriptPath
        let args = []

        if (installation.mode === 'scale') {
            // In scale mode, we run the patch/token generation script on the bridge master
            onLog('info', 'checking HA configuration and generating fresh join tokens...')
            scriptPath = join(__dirname, '../automation/patch-cluster-ha.sh')
            args = [masterNode.ip]
        } else {
            // In install mode, we run the full init script
            scriptPath = join(__dirname, '../automation/init-control-plane.sh')
            const k8sVersion = installation.k8sVersion
            const podNetworkCidr = installation.networkPlugin === 'calico' ? '192.168.0.0/16' : '10.244.0.0/16'

            onLog('info', `Control plane endpoint: ${masterNode.ip}:6443`)
            onLog('info', `Pod network CIDR: ${podNetworkCidr}`)
            args = [masterNode.ip, podNetworkCidr, k8sVersion]
        }

        try {
            await this.executeScript(ssh, scriptPath, args, onLog)

            // Read join data from files created by the script
            const joinResult = await ssh.execCommand('cat /tmp/kubeadm-join-command.txt')
            const joinCommand = joinResult.stdout.trim()

            const certKeyResult = await ssh.execCommand('cat /tmp/kubeadm-cert-key.txt')
            const certKey = certKeyResult.stdout.trim()

            onLog('success', '✓ Control plane join data refreshed')
            onLog('info', `Cluster endpoint: https://${masterNode.ip}:6443`)

            return { joinCommand, certKey }
        } finally {
            ssh.dispose()
        }
    }

    async installNetworkPlugin(installation, onLog) {
        const plugin = installation.networkPlugin

        if (this.simulationMode) {
            onLog('info', `[SIMULATION] Installing ${plugin} network plugin...`)
            await this.sleep(2000)
            onLog('success', `[SIMULATION] ✓ ${plugin} network plugin installed`)
            return
        }

        onLog('info', `Installing ${plugin} network plugin...`)

        const masterNode = installation.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)

        const scriptPath = join(__dirname, '../automation/install-network-plugin.sh')

        const cidr = installation.podNetworkCidr || '10.244.0.0/16'

        try {
            await this.executeScript(ssh, scriptPath, [plugin, cidr], onLog)
            onLog('success', `✓ ${plugin} network plugin installed`)
        } finally {
            ssh.dispose()
        }
    }

    async joinNodes(installation, joinData, onLog) {
        const { joinCommand, certKey } = joinData
        const masters = installation.masterNodes || []
        const workers = installation.workerNodes || []

        if (this.simulationMode) {
            // ... (keep simulation logic if needed or skip)
            return
        }

        const masterScriptPath = join(__dirname, '../automation/join-master.sh')
        const workerScriptPath = join(__dirname, '../automation/join-worker.sh')

        // 1. Join additional Master nodes (starting from index 1)
        for (let i = 1; i < masters.length; i++) {
            const node = masters[i]
            const ssh = await this.connectSSH(node)
            onLog('info', `Joining additional Master node ${i + 1}: ${node.ip}`)
            try {
                // Use join-master.sh with certKey for control plane join
                await this.executeScript(ssh, masterScriptPath, [joinCommand, certKey], onLog)
                onLog('success', `✓ Master node ${i + 1} (${node.ip}) joined control plane`)
            } finally {
                ssh.dispose()
            }
        }

        // 2. Join Worker nodes
        for (let i = 0; i < workers.length; i++) {
            const node = workers[i]
            const ssh = await this.connectSSH(node)
            onLog('info', `Joining worker node ${i + 1}: ${node.ip}`)
            try {
                // Use join-worker.sh for worker nodes
                await this.executeScript(ssh, workerScriptPath, [joinCommand], onLog)
                onLog('success', `✓ Worker node ${i + 1} (${node.ip}) joined successfully`)
            } finally {
                ssh.dispose()
            }
        }
    }

    async installAddons(installation, onLog) {
        const addons = installation.addons || {}

        if (!Object.values(addons).some(v => v)) {
            onLog('info', 'No add-ons selected, skipping...')
            return
        }

        const addonList = []
        if (addons.ingress) addonList.push('Ingress')
        if (addons.monitoring) addonList.push('Monitoring')
        if (addons.logging) addonList.push('Logging')
        if (addons.dashboard) addonList.push('Dashboard')

        if (this.simulationMode) {
            onLog('info', `[SIMULATION] Installing add-ons (${addonList.join(', ')})...`)
            await this.sleep(2000)
            onLog('success', `[SIMULATION] ✓ All add-ons installed successfully`)
            return
        }

        const masterNode = installation.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)
        const scriptPath = join(__dirname, '../automation/install-addons.sh')

        try {
            const scriptAddons = []
            if (addons.ingress) scriptAddons.push('ingress')
            if (addons.monitoring) scriptAddons.push('monitoring')
            if (addons.logging) scriptAddons.push('logging')
            if (addons.dashboard) scriptAddons.push('dashboard')

            onLog('info', `Installing add-ons: ${addonList.join(', ')}`)
            onLog('info', 'Waiting 60 seconds for cluster networking to settle and nodes to become Ready...')
            await this.sleep(60000)

            for (const addon of scriptAddons) {
                onLog('info', `Step: Installing ${addon}...`)
                await this.executeScript(ssh, scriptPath, [addon], onLog)
            }

            onLog('success', '✓ All add-ons installed successfully')
        } finally {
            ssh.dispose()
        }
    }

    async postInstallationValidation(installation, onLog) {
        if (this.simulationMode) {
            onLog('info', '[SIMULATION] Validating cluster health...')
            await this.sleep(1500)
            onLog('success', '[SIMULATION] ✓ All nodes are Ready')
            onLog('success', '[SIMULATION] ✓ All system pods are Running')
            onLog('success', '[SIMULATION] ✓ Cluster is healthy')
            return
        }

        onLog('info', 'Validating cluster health...')
        await this.sleep(15000)

        const masterNode = installation.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)
        const kubeconfig = 'export KUBECONFIG=/etc/kubernetes/admin.conf && '

        try {
            // Check nodes
            const nodesResult = await ssh.execCommand(`${kubeconfig} kubectl get nodes`)
            onLog('info', 'Cluster nodes:')
            if (nodesResult.stdout) {
                nodesResult.stdout.split('\n').forEach(line => {
                    if (line.trim()) onLog('info', `  ${line}`)
                })
            }

            // Check system pods
            const podsResult = await ssh.execCommand(`${kubeconfig} kubectl get pods -n kube-system`)
            onLog('info', 'System pods:')
            if (podsResult.stdout) {
                podsResult.stdout.split('\n').slice(0, 5).forEach(line => {
                    if (line.trim()) onLog('info', `  ${line}`)
                })
            }

            // Verify all nodes are Ready
            const readyCheck = await ssh.execCommand(`${kubeconfig} kubectl get nodes | grep -c Ready`)
            const readyCount = parseInt(readyCheck.stdout.trim()) || 0
            const totalNodes = installation.masterNodes.length + (installation.workerNodes?.length || 0)

            if (readyCount >= totalNodes) {
                onLog('success', `✓ All ${totalNodes} nodes are Ready`)
            } else {
                onLog('warning', `⚠ Only ${readyCount}/${totalNodes} nodes are Ready`)
            }

            onLog('success', '✓ Cluster validation completed')
        } finally {
            ssh.dispose()
        }
    }
}

export const automationEngine = new AutomationEngine()
