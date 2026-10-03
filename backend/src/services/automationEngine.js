import { NodeSSH } from 'node-ssh'
import { sshRefusedMessage } from '../utils/sshFixHint.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { agentService } from './agentService.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

class AgentSSHProxy {
    constructor(agentId, nodeConfig) {
        this.agentId = agentId
        this.nodeConfig = nodeConfig
    }

    async connect() { return true; } // Agent manages connection lazily

    async execCommand(command, config = {}) {
        try {
            // Default 10-min relay timeout — cluster/addon operations (kubectl
            // rollout status, image pulls) can run for several minutes via the
            // tunnel. Long scripts (upgrades) pass a bigger config.timeoutMs.
            const result = await agentService.relaySSH(this.agentId, this.nodeConfig, command, config.timeoutMs || 600000)

            // Handle output callbacks if provided
            if (config.onStdout && result.stdout) config.onStdout(Buffer.from(result.stdout))
            if (config.onStderr && result.stderr) config.onStderr(Buffer.from(result.stderr))

            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr }
        } catch (e) {
            // A failed remote command still has output (incl. the script's
            // KUBEEZ_FAIL reason) — stream and return it instead of dropping it.
            if (config.onStdout && e.stdout) config.onStdout(Buffer.from(e.stdout))
            if (config.onStderr) config.onStderr(Buffer.from(e.stderr || e.message))
            return { code: e.exitCode || 1, stdout: e.stdout || '', stderr: e.stderr || e.message }
        }
    }

    dispose() { } // Handled by agent
}

class AutomationEngine {
    // Scripts report failures as "KUBEEZ_FAIL|CODE|reason|fix" — the last one wins.
    parseScriptFailure(output) {
        const lines = String(output || '').split('\n').filter(l => l.includes('KUBEEZ_FAIL|'))
        if (!lines.length) return null
        const last = lines[lines.length - 1]
        const [, code, reason, fix] = last.slice(last.indexOf('KUBEEZ_FAIL|')).split('|')
        return {
            reason: (code || 'SCRIPT_FAILED').trim(),
            message: (reason || 'The script stopped with an error.').trim(),
            suggestedFix: (fix || 'Check the log above, then retry.').trim(),
            fixAction: 'retry_step'
        }
    }

    async executeScript(ssh, scriptPath, args = [], onLog, options = {}) {
        let remotePath
        try {
            // Read script content
            const scriptContent = readFileSync(scriptPath, 'utf8')

            // Upload script to remote node
            remotePath = `/tmp/kubeez-${Date.now()}.sh`
            await ssh.execCommand(`cat > ${remotePath} << 'EOFSCRIPT'\n${scriptContent}\nEOFSCRIPT`)
            await ssh.execCommand(`chmod +x ${remotePath}`)

            onLog('info', `Script execution started: ${scriptPath.split(/[\\/]/).pop()}`)

            // VALIDATION: Strict validation of arguments to prevent injection
            const safeArgs = args.map(arg => {
                const s = String(arg)
                // Allow alphanumeric, dashes, dots, underscores, slashes, colons
                if (!/^[\w\-\.\:\/\s]+$/.test(s)) {
                    throw new Error(`Invalid argument detected (security check): ${s}`)
                }
                return s
            }).map(arg => `'${arg}'`).join(' ')

            // Machine-readable lines are consumed here, never shown in the log:
            //   KUBEEZ_PROGRESS|<0-100>|<label>  → options.onStageProgress
            //   KUBEEZ_FAIL|...                  → failure screen (parsed below)
            const handleLine = (line, fromStderr) => {
                if (!line.trim()) return
                const p = line.indexOf('KUBEEZ_PROGRESS|')
                if (p >= 0) {
                    const [, pct, label] = line.slice(p).split('|')
                    const n = parseInt(pct, 10)
                    if (!isNaN(n) && options.onStageProgress) options.onStageProgress(Math.max(0, Math.min(100, n)), (label || '').trim())
                    return
                }
                if (line.includes('KUBEEZ_FAIL|')) return
                if (fromStderr && (line.includes('warning') || line.includes('Error') || line.includes('fail'))) {
                    onLog('warning', line)
                } else {
                    onLog('info', line)
                }
            }
            // Chunks can split a line in two — buffer until the newline arrives
            const lineReader = (fromStderr) => {
                let buf = ''
                return {
                    push: (chunk) => {
                        buf += chunk.toString('utf8')
                        const lines = buf.split('\n')
                        buf = lines.pop()
                        lines.forEach(l => handleLine(l.replace(/\r$/, ''), fromStderr))
                    },
                    flush: () => { if (buf) handleLine(buf.replace(/\r$/, ''), fromStderr); buf = '' }
                }
            }
            const out = lineReader(false)
            const errOut = lineReader(true)

            const result = await ssh.execCommand(`sudo bash ${remotePath} ${safeArgs}`, {
                timeoutMs: options.timeoutMs,
                onStdout: out.push,
                onStderr: errOut.push
            })
            out.flush()
            errOut.flush()

            if (result.code !== 0) {
                const combinedOutput = ((result.stderr || '') + '\n' + (result.stdout || '')).trim()
                // Prefer the script's own explanation (exact reason + fix)
                const structured = this.parseScriptFailure(combinedOutput)
                if (structured) {
                    const error = new Error(structured.message)
                    error.diagnosis = structured
                    error.rawOutput = combinedOutput
                    throw error
                }
                // INTELLIGENT ERROR ANALYSIS (scripts without structured output)
                const error = new Error(combinedOutput || 'Unknown script error')
                error.diagnosis = this.analyzeError(combinedOutput)
                throw error
            }

            return result
        } catch (error) {
            if (error.diagnosis) throw error;
            throw new Error(`Failed to execute script: ${error.message}`)
        } finally {
            // Ensure cleanup happens even on error
            if (remotePath) {
                await ssh.execCommand(`rm -f ${remotePath}`).catch(() => { })
            }
        }
    }

    analyzeError(output) {
        const errorLog = output.toLowerCase()

        if (errorLog.includes('could not get lock') ||
            errorLog.includes('resource temporarily unavailable') ||
            errorLog.includes('waiting for cache lock') ||
            errorLog.includes('dpkg: error: dpkg frontend is locked') ||
            errorLog.includes('dpkg frontend is locked')) {
            return {
                reason: 'Package Manager Locked',
                message: 'Another process is using apt/dpkg. Auto-healing will forcefully clear the locks.',
                suggestedFix: 'Kill background apt processes and remove lock files.',
                fixAction: 'fix_dpkg_lock'
            }
        }

        // CentOS 7 EOL repo failures (vault.centos.org 403 / DNS failure)
        if (errorLog.includes('errno 256') ||
            errorLog.includes('no more mirrors to try') ||
            (errorLog.includes('vault.centos.org') && (errorLog.includes('errno 14') || errorLog.includes('403'))) ||
            errorLog.includes('repodata') && errorLog.includes('from base:')) {
            return {
                reason: 'CentOS 7 EOL Repository Failure',
                message: 'CentOS 7 repos are broken (EOL). Auto-healing will patch all repos to vault.centos.org and fix DNS.',
                suggestedFix: 'Run fix-os-repos.sh to patch CentOS 7 EOL repositories and configure DNS.',
                fixAction: 'fix_centos7_repos'
            }
        }

        // IPv6 connectivity failure (curl#7)
        if (errorLog.includes('curl#7') ||
            errorLog.includes('failed to connect to') && errorLog.includes(':') ||
            errorLog.includes('network is unreachable') && errorLog.includes('ipv6')) {
            return {
                reason: 'IPv6 Network Unreachable',
                message: 'Node has no IPv6 connectivity. Auto-healing will force IPv4 for all package managers.',
                suggestedFix: 'Disable IPv6 and force ip_resolve=4 for yum/dnf/apt.',
                fixAction: 'fix_ipv6_force'
            }
        }

        if (errorLog.includes('running with swap on is not supported') ||
            errorLog.includes('swap is enabled') ||
            errorLog.includes('swapoff') ||
            errorLog.includes('swap:')) {
            return {
                reason: 'Swap Memory Enabled',
                message: 'Kubernetes requires swap memory to be disabled. Auto-healing will permanently disable swap.',
                suggestedFix: 'Disable swap immediately.',
                fixAction: 'fix_swap_off'
            }
        }

        if (errorLog.includes('port 6443 is already in use') ||
            errorLog.includes('address already in use') ||
            errorLog.includes('bind: address already in use')) {
            return {
                reason: 'Port Conflict',
                message: 'Port 6443 is already in use. Auto-healing will automatically reset the previous Kubernetes state.',
                suggestedFix: 'Reset Kubernetes configuration and kill conflicting processes.',
                fixAction: 'fix_kube_reset'
            }
        }

        if (errorLog.includes('connection timed out') ||
            errorLog.includes('connection refused') ||
            errorLog.includes('no route to host') ||
            errorLog.includes('network is unreachable')) {
            return {
                reason: 'Network Timeout',
                message: 'SSH or Network connection failed. Auto-healing will retry the connection.',
                suggestedFix: 'Retry connection and check Firewall settings.',
                fixAction: 'retry_connection'
            }
        }

        if (errorLog.includes('could not resolve host') ||
            errorLog.includes('curl#6') ||
            errorLog.includes('name or service not known') ||
            errorLog.includes('temporary failure in name resolution') ||
            errorLog.includes('could not resolve dns')) {
            return {
                reason: 'DNS/Internet Failure',
                message: 'Node cannot resolve domain names. Auto-healing will automatically inject Google Public DNS (8.8.8.8).',
                suggestedFix: 'Configure Google DNS (8.8.8.8) and retry.',
                fixAction: 'fix_dns_resolv'
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
            else if (fixAction === 'fix_centos7_repos' || fixAction === 'fix_ipv6_force') {
                // Fast, transparent, step-by-step repo repair (no slow makecache —
                // skip_if_unavailable in the repo files handles broken mirrors, and
                // the retried install fetches only what it needs).
                onLog('info', '🩺 Auto-Doctor: Repairing OS package repositories...')

                onLog('info', '  → Step 1/4: Setting reliable DNS (8.8.8.8, 1.1.1.1)...')
                await ssh.execCommand(`sudo bash -c 'grep -q 8.8.8.8 /etc/resolv.conf 2>/dev/null || printf "nameserver 8.8.8.8\\nnameserver 1.1.1.1\\noptions timeout:2 attempts:3\\n" > /etc/resolv.conf' || true`)

                onLog('info', '  → Step 2/4: Forcing IPv4 for package managers...')
                await ssh.execCommand(`sudo bash -c 'grep -q ^ip_resolve /etc/yum.conf 2>/dev/null || echo ip_resolve=4 >> /etc/yum.conf' || true`)
                await ssh.execCommand(`sudo bash -c '[ -f /etc/dnf/dnf.conf ] && { grep -q ^ip_resolve /etc/dnf/dnf.conf || echo ip_resolve=4 >> /etc/dnf/dnf.conf; }' || true`)

                onLog('info', '  → Step 3/4: Detecting OS version...')
                const osCheck = await ssh.execCommand('. /etc/os-release 2>/dev/null; echo "${ID:-unknown} ${VERSION_ID:-0}"')
                const osStr = (osCheck.stdout || '').trim()
                onLog('info', `      Detected: ${osStr}`)

                if (/^centos 7/i.test(osStr)) {
                    onLog('info', '  → Step 4/4: CentOS 7 is End-of-Life — repointing repos to vault.centos.org archive...')
                    const vaultRepo = [
                        '[base]', 'name=CentOS-7 - Base (Vault)', 'baseurl=http://vault.centos.org/centos/7/os/$basearch/', 'gpgcheck=0', 'enabled=1', 'skip_if_unavailable=1', 'timeout=15', 'ip_resolve=4', '',
                        '[updates]', 'name=CentOS-7 - Updates (Vault)', 'baseurl=http://vault.centos.org/centos/7/updates/$basearch/', 'gpgcheck=0', 'enabled=1', 'skip_if_unavailable=1', 'timeout=15', 'ip_resolve=4', '',
                        '[extras]', 'name=CentOS-7 - Extras (Vault)', 'baseurl=http://vault.centos.org/centos/7/extras/$basearch/', 'gpgcheck=0', 'enabled=1', 'skip_if_unavailable=1', 'timeout=15', 'ip_resolve=4'
                    ].join('\n')
                    await ssh.execCommand(`sudo rm -f /etc/yum.repos.d/CentOS-*.repo 2>/dev/null || true`)
                    await ssh.execCommand(`sudo bash -c 'cat > /etc/yum.repos.d/CentOS-Vault.repo <<"VAULTEOF"\n${vaultRepo}\nVAULTEOF'`)
                    onLog('info', '      Clearing stale package cache...')
                    await ssh.execCommand('sudo yum clean all 2>/dev/null || true')
                    await ssh.execCommand('sudo rm -rf /var/cache/yum/* 2>/dev/null || true')
                    onLog('success', '✓ CentOS 7 repos repaired → vault archive, broken mirrors will be skipped automatically.')
                } else if (/ubuntu|debian/i.test(osStr)) {
                    onLog('info', '  → Step 4/4: Forcing IPv4 + retries for APT...')
                    await ssh.execCommand(`sudo bash -c 'mkdir -p /etc/apt/apt.conf.d; printf "Acquire::ForceIPv4 \\"true\\";\\nAcquire::Retries \\"3\\";\\n" > /etc/apt/apt.conf.d/99kubeez-ipv4' || true`)
                    onLog('success', '✓ APT configured for reliable IPv4 downloads.')
                } else {
                    onLog('success', '✓ DNS and IPv4 configured for package downloads.')
                }
            }
            else if (fixAction === 'fix_dns_resolv' || fixAction === 'retry_connection') {
                // Force DNS + IPv4
                await ssh.execCommand(`sudo bash -c 'echo "nameserver 8.8.8.8" > /etc/resolv.conf && echo "nameserver 1.1.1.1" >> /etc/resolv.conf && echo "nameserver 8.8.4.4" >> /etc/resolv.conf'`)
                // Also force IPv4 for yum/dnf
                await ssh.execCommand("grep -q 'ip_resolve' /etc/yum.conf 2>/dev/null || echo 'ip_resolve=4' | sudo tee -a /etc/yum.conf || true")
                await ssh.execCommand("grep -q 'ip_resolve' /etc/dnf/dnf.conf 2>/dev/null || echo 'ip_resolve=4' | sudo tee -a /etc/dnf/dnf.conf || true")
                // Force IPv4 for APT
                await ssh.execCommand("echo 'Acquire::ForceIPv4 \"true\";' | sudo tee /etc/apt/apt.conf.d/99kubeez-ipv4 2>/dev/null || true")
                onLog('success', '✓ Patched DNS (8.8.8.8/1.1.1.1) and forced IPv4 for package managers.')
            }
            else if (fixAction === 'retry_step') {
                onLog('info', 'Assuming transient error. Retrying...')
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
        // Check if a Gateway Agent is available for this owner
        if (node.ownerId || node.orgId) {
            const gatewayAgent = await agentService.getGatewayAgentForOwner(node.ownerId, 'admin', node.orgId)
            if (gatewayAgent) {
                console.log(`[AutomationEngine] Routing SSH to ${node.ip} via Gateway Agent ${gatewayAgent.agentId}`)
                const proxy = new AgentSSHProxy(gatewayAgent.agentId, node)
                await proxy.connect()

                if (node.username !== 'root') {
                    await this.ensurePasswordlessSudo(proxy, node)
                }
                return proxy
            }
        }

        console.log(`[AutomationEngine] Direct SSH to ${node.ip}`)
        const ssh = new NodeSSH()
        await ssh.connect({
            host: node.ip,
            username: node.username,
            password: node.password,
            privateKey: node.sshKey || undefined,
            readyTimeout: 30000
        })

        // Auto-configure passwordless sudo for non-root users
        if (node.username !== 'root') {
            try {
                await this.ensurePasswordlessSudo(ssh, node)
            } catch (err) {
                // If it fails here, it might be due to SSH connectivity issues
                // being delayed until the first execCommand
                if (err.message.includes('ECONNREFUSED')) {
                    throw new Error(sshRefusedMessage(`${node.ip}:22`))
                }
                if (err.message.includes('Timed out while waiting for handshake')) {
                    throw new Error(`SSH Handshake Timeout on ${node.ip}.\n\nFIX: Verify the IP is correct and Port 22 is open on the host's firewall.`)
                }
                throw err
            }
        }

        return ssh
    }

    async ensurePasswordlessSudo(ssh, node) {
        try {
            // Check if user already has passwordless sudo
            const sudoCheck = await ssh.execCommand('sudo -n true 2>/dev/null', {
                options: { pty: false }
            })

            if (sudoCheck.code === 0) {
                // Already has passwordless sudo
                return
            }

            // User needs passwordless sudo - configure it automatically
            const username = node.username

            // Validate username to only allow safe characters (prevents injection via sudoers path/content)
            if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
                throw new Error(`Invalid SSH username for sudo configuration: ${username}`)
            }

            const sudoersFile = `/etc/sudoers.d/kubeez-${username}`

            // Escape single quotes in password for safe single-quote shell embedding
            const escapedPassword = node.password.replace(/'/g, "'\\''")
            const setupCommand = `echo '${escapedPassword}' | sudo -S bash -c "echo '${username} ALL=(ALL) NOPASSWD:ALL' > ${sudoersFile} && chmod 0440 ${sudoersFile}"`

            const result = await ssh.execCommand(setupCommand, {
                options: { pty: true }
            })

            if (result.code !== 0) {
                throw new Error(`Failed to configure passwordless sudo: ${result.stderr}`)
            }

            // Verify it worked
            const verifyCheck = await ssh.execCommand('sudo -n true 2>/dev/null')
            if (verifyCheck.code !== 0) {
                throw new Error('Passwordless sudo verification failed')
            }

        } catch (error) {
            // Intercept common SSH networking errors that surface here
            if (error.message.includes('ECONNREFUSED')) {
                throw new Error(sshRefusedMessage(`${node.ip}:22`))
            }
            if (error.message.includes('Timed out while waiting for handshake')) {
                throw new Error(`SSH Handshake Timeout on ${node.ip}.\n\nFIX: Verify the IP is correct and Port 22 is open on the host's firewall.`)
            }

            // If auto-setup fails for auth/permission reasons, throw a helpful error
            throw new Error(
                `Cannot configure passwordless sudo for user '${node.username}' on ${node.ip}. ` +
                `Please either: (1) Use 'root' user, or (2) Manually configure passwordless sudo. ` +
                `Error: ${error.message}`
            )
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    async install(installation, callbacks) {
        const { onProgress, onLog, onComplete, onError } = callbacks
        // Cancellation checkpoint — throws if the user cancelled (no-op if not provided)
        const ck = () => { if (typeof callbacks.checkCancel === 'function') callbacks.checkCancel() }

        try {
            onLog('info', 'Starting deployment initialization...')
            onProgress(1, 'Initializing...')

            // Inject ownerId + orgId into nodes for Gateway Agent routing
            if (installation.ownerId) {
                installation.masterNodes.forEach(n => {
                    n.ownerId = installation.ownerId
                    n.orgId   = installation.orgId
                })
                if (installation.workerNodes) {
                    installation.workerNodes.forEach(n => {
                        n.ownerId = installation.ownerId
                        n.orgId   = installation.orgId
                    })
                }
            }

            // Determine simulation mode — tracked per installation (never on the
            // shared engine) so concurrent installs can't flip each other's mode.
            // An unreachable master FAILS the install unless simulation is
            // explicitly enabled; never report a fake cluster as "completed".
            const reachable = await this.detectRealNodes(installation, onLog)
            if (!reachable && process.env.KUBEEZ_ALLOW_SIMULATION !== 'true') {
                throw new Error('Cannot reach the master node over SSH — installation aborted. Check the IP, credentials, that port 22 is open, and that your Gateway Agent is online.')
            }
            installation.simulationMode = !reachable

            if (installation.simulationMode) {
                onLog('warning', '⚠️ No real nodes detected - Running in SIMULATION mode')
                onLog('warning', '⚠️ To use real installation, provide actual Linux machines with SSH access')
            }

            // ==========================================
            // MODE: ADD-ON ONLY (Day-2 Operations)
            // ==========================================
            if (installation.mode === 'addon-only') {
                onLog('info', '🚀 Mode: Add-on Installation Only')
                onProgress(10, 'Verifying connectivity...')
                await this.validateConnectivity(installation, onLog)

                onProgress(50, 'Installing selected add-ons...')
                await this.installAddons(installation, onLog)

                onProgress(100, 'Add-on installation completed!')
                onLog('success', '✅ Add-ons installed successfully!')

                const clusterInfo = {
                    name: installation.clusterName,
                    version: installation.k8sVersion,
                    nodes: [
                        ...installation.masterNodes.map(n => ({
                            name: n.hostname || `master-${n.ip}`,
                            ip: n.ip,
                            role: 'master',
                            status: 'Ready'
                        })),
                        ...(installation.workerNodes || []).map(n => ({
                            name: n.hostname || `worker-${n.ip}`,
                            ip: n.ip,
                            role: 'worker',
                            status: 'Ready'
                        }))
                    ],
                    nodeCount: installation.masterNodes.length + (installation.workerNodes?.length || 0),
                    endpoint: `https://${installation.masterNodes[0].ip}:6443`,
                    simulationMode: installation.simulationMode
                }

                onComplete(clusterInfo)
                return
            }

            // Step 1: Validate connectivity
            ck()
            onProgress(5, 'Validating node connectivity...')
            await this.validateConnectivity(installation, onLog)

            // Step 1.5: Pre-flight checks
            ck()
            onProgress(8, 'Running pre-flight checks...')
            await this.preFlightChecks(installation, onLog)

            // Step 2: Configure Firewall
            ck()
            onProgress(12, 'Configuring firewall rules...')
            await this.configureFirewall(installation, onLog)

            // Step 2b: Brute Force Time Sync (Master as Source of Truth)
            onProgress(15, 'Force-Syncing clocks and hostnames...')
            if (!installation.simulationMode) {
                const masterNode = installation.masterNodes[0]
                const masterSsh = await this.connectSSH(masterNode)
                const timeResult = await masterSsh.execCommand('date +"%m%d%H%M%Y.%S"')
                const masterTime = timeResult.stdout.trim()
                masterSsh.dispose()

                const allNodes = [...installation.masterNodes, ...(installation.workerNodes || [])]
                const hostsEntries = allNodes.map(n => {
                    const raw = n.hostname || `node-${n.ip.replace(/\./g, '-')}`
                    // Sanitize: RFC 952/1123 — only alphanumeric, hyphens, dots, max 63 chars
                    const hn = raw.replace(/[^a-zA-Z0-9\-\.]/g, '').substring(0, 63)
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
            } else {
                onLog('info', '[SIMULATION] Skipping clock sync and hostname configuration.')
                await this.sleep(1000)
            }

            // Step 3: Install container runtime
            ck()
            onProgress(20, 'Installing container runtime (containerd)...')
            await this.installContainerRuntime(installation, onLog)

            // Step 4: Install Kubernetes components
            ck()
            onProgress(35, 'Installing kubeadm, kubelet, kubectl...')
            await this.installKubernetesComponents(installation, onLog)

            // Step 5: Initialize control plane
            ck()
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
            ck()
            onProgress(75, 'Joining nodes to cluster...')
            await this.joinNodes(installation, joinCommand, onLog)

            // Step 8: Install add-ons (Skip in Scale mode as they are cluster-wide)
            if (installation.mode === 'scale') {
                onLog('info', '⏭️ Scaling Mode: Skipping add-on installation (Cluster already configured)')
            } else {
                ck()
                onProgress(85, 'Installing add-ons...')
                await this.installAddons(installation, onLog)
            }

            // Step 9: Post-installation validation
            onProgress(95, 'Running cluster validation...')
            await this.postInstallationValidation(installation, onLog)

            // Complete
            onProgress(100, 'Installation completed successfully!')

            if (installation.simulationMode) {
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
                simulationMode: installation.simulationMode
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
            return false
        }
    }

    async validateConnectivity(installation, onLog) {
        if (installation.simulationMode) {
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
            let ssh
            try {
                ssh = await this.connectSSH(node)

                // Get OS info
                const osInfo = await ssh.execCommand('cat /etc/os-release')
                const osMatch = osInfo.stdout.match(/ID=["']?([^"\n]+)["']?/)
                const osType = osMatch ? osMatch[1] : 'unknown'

                onLog('success', `✓ Connected to ${node.type} node: ${node.ip} (${osType})`)
            } catch (error) {
                throw new Error(`Failed to connect to ${node.type} node ${node.ip}: ${error.message}`)
            } finally {
                if (ssh) ssh.dispose()
            }
        }
    }

    async configureFirewall(installation, onLog) {
        if (installation.simulationMode) {
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
        if (installation.simulationMode) {
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
        if (installation.simulationMode) {
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
        if (installation.simulationMode) {
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
        if (installation.simulationMode) {
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
            const podNetworkCidr = this.podNetworkCidr(installation)

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

    // One source of truth for the pod CIDR — kubeadm init and the CNI must agree,
    // otherwise Calico pods get IPs outside the cluster's podSubnet.
    podNetworkCidr(installation) {
        return installation.podNetworkCidr || (installation.networkPlugin === 'calico' ? '192.168.0.0/16' : '10.244.0.0/16')
    }

    async installNetworkPlugin(installation, onLog) {
        const plugin = installation.networkPlugin

        if (installation.simulationMode) {
            onLog('info', `[SIMULATION] Installing ${plugin} network plugin...`)
            await this.sleep(2000)
            onLog('success', `[SIMULATION] ✓ ${plugin} network plugin installed`)
            return
        }

        onLog('info', `Installing ${plugin} network plugin...`)

        const masterNode = installation.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)

        const scriptPath = join(__dirname, '../automation/install-network-plugin.sh')

        // Must match the podSubnet kubeadm init used (calico: 192.168.0.0/16)
        const cidr = this.podNetworkCidr(installation)

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

        if (installation.simulationMode) {
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

        if (installation.simulationMode) {
            onLog('info', `[SIMULATION] Installing add-ons (${addonList.join(', ')})...`)
            await this.sleep(2000)
            onLog('success', `[SIMULATION] ✓ All add-ons installed successfully`)
            return
        }

        const masterNode = installation.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)
        const scriptPath = join(__dirname, '../automation/install-addons.sh')

        try {
            const addonsToInstall = []

            // Legacy addons (handled by install-addons.sh)
            if (addons.ingress) addonsToInstall.push({ type: 'legacy', name: 'ingress', label: 'Nginx Ingress' })
            if (addons.monitoring) addonsToInstall.push({ type: 'legacy', name: 'monitoring', label: 'Prometheus Stack' })
            if (addons.logging) addonsToInstall.push({ type: 'legacy', name: 'logging', label: 'EFK Stack' })
            if (addons.dashboard) addonsToInstall.push({ type: 'legacy', name: 'dashboard', label: 'Kubernetes Dashboard' })

            // New addons (dedicated scripts)
            // Note: Frontend sends 'cert-manager', Backend previously checked 'certManager'
            if (addons.certManager || addons['cert-manager']) addonsToInstall.push({ type: 'script', script: 'addons/cert-manager.sh', label: 'Cert Manager' })
            if (addons.longhorn) addonsToInstall.push({ type: 'script', script: 'addons/longhorn.sh', label: 'Longhorn Storage' })
            if (addons.argocd) addonsToInstall.push({ type: 'script', script: 'addons/argocd.sh', label: 'ArgoCD' })
            if (addons.seaweedfs) addonsToInstall.push({ type: 'script', script: 'addons/seaweedfs.sh', label: 'S3 Object Storage (SeaweedFS)' })

            if (addonsToInstall.length === 0) {
                onLog('info', 'No valid add-ons selected to install.')
                return
            }

            const addonNames = addonsToInstall.map(a => a.label).join(', ')
            onLog('info', `Installing add-ons: ${addonNames}`)
            onLog('info', 'Waiting 60 seconds for cluster networking to settle and nodes to become Ready...')
            // Emit periodic progress so the log stream never goes silent for 60s
            // (keeps the WebSocket alive through proxies/Cloudflare)
            for (let s = 15; s <= 60; s += 15) {
                await this.sleep(15000)
                onLog('info', `...settling (${s}s / 60s)`)
            }

            const legacyScriptPath = join(__dirname, '../automation/install-addons.sh')

            // Add-ons pull images and wait for rollouts — through a Gateway Agent the
            // default 10-min relay timeout cut them off. Scripts bound their own waits.
            const addonOpts = { timeoutMs: 30 * 60 * 1000 }
            for (const item of addonsToInstall) {
                onLog('info', `Step: Installing ${item.label}...`)
                try {
                    if (item.type === 'legacy') {
                        await this.executeScript(ssh, legacyScriptPath, [item.name], onLog, addonOpts)
                    } else {
                        const scriptPath = join(__dirname, '../automation', item.script)
                        await this.executeScript(ssh, scriptPath, [], onLog, addonOpts)
                    }
                    onLog('success', `✓ ${item.label} installed successfully`)
                } catch (err) {
                    onLog('error', `❌ Failed to install ${item.label}: ${err.message}`)
                    // Continue with other addons instead of failing entire process?
                    // Usually better to throw so user knows, but for addons, partial success might be better.
                    // For now, let's allow it to propagate if critical, or maybe log and verify?
                    // automationEngine install method catches errors. So if we throw, it stops.
                    // Given user wants "everything installable", stopping is safer to debug.
                    throw err
                }
            }

            onLog('success', '✓ Selected add-ons installation phase completed')
        } finally {
            ssh.dispose()
        }
    }

    async postInstallationValidation(installation, onLog) {
        if (installation.simulationMode) {
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

    async upgradeCluster(cluster, targetVersion, callbacks) {
        const { onLog, onProgress, onComplete, onError } = callbacks

        try {
            onLog('info', `🚀 Starting Cluster Upgrade to v${targetVersion}...`)
            onLog('info', '🛟 A safety etcd snapshot will be taken automatically on the primary control-plane before any changes (saved to /var/lib/etcd-backup).')

            if (cluster.simulationMode) {
                onLog('info', '[SIMULATION] Upgrading cluster components...')
                await this.sleep(3000)
                onLog('success', `[SIMULATION] ✓ Cluster upgraded to v${targetVersion}`)
                onComplete({ ...cluster, version: targetVersion })
                return
            }

            const scriptPath = join(__dirname, '../automation/upgrade-cluster.sh')

            // VALIDATION: Strict Version Path Check
            try {
                this.validateUpgradePath(cluster.k8sVersion, targetVersion)
            } catch (err) {
                err.diagnosis = {
                    reason: 'INVALID_UPGRADE_PATH',
                    message: err.message,
                    suggestedFix: 'Upgrade one minor version at a time (e.g. 1.34 → 1.35 → 1.36).',
                    fixAction: 'retry_step'
                }
                throw err
            }

            const allNodes = [
                ...cluster.masterNodes.map(n => ({ ...n, role: 'master' })),
                ...(cluster.workerNodes || []).map(n => ({ ...n, role: 'worker' }))
            ]

            // ── Preflight on EVERY node before touching ANY node ──────────────────
            // Runs the upgrade script in read-only "check" mode (kernel, cgroups
            // v2, containerd, disk, repo/registry reachability, version path).
            // A blocker on any node stops here with an exact reason — so we never
            // end up with a half-upgraded cluster.
            // Overall progress bar: preflight = 0–5%, then each node gets an equal
            // slice of 5–99% filled from the script's own stage markers. The bar
            // only ever moves forward.
            let lastPct = 0
            const report = (pct, step) => {
                const p = Math.min(99, Math.max(lastPct, Math.floor(pct)))
                lastPct = p
                onProgress(p, step)
            }
            const PREFLIGHT_END = 5
            const nodeSpan = (99 - PREFLIGHT_END) / allNodes.length

            onLog('info', `🔎 Preflight: checking all ${allNodes.length} node(s) for Kubernetes v${targetVersion}...`)
            report(1, 'Preflight checks on all nodes...')
            for (let i = 0; i < allNodes.length; i++) {
                const node = allNodes[i]
                const isFirstMaster = node.role === 'master' && i === 0
                const ssh = await this.connectSSH(node)
                try {
                    report(1 + ((PREFLIGHT_END - 1) * i) / allNodes.length, `Preflight check on ${node.ip} (${i + 1}/${allNodes.length})...`)
                    onLog('info', `Preflight on ${node.ip} (${node.role})...`)
                    await this.executeScript(ssh, scriptPath, [targetVersion, node.role, isFirstMaster ? 'true' : 'false', 'check'], onLog)
                } catch (err) {
                    const e = new Error(`Preflight failed on ${node.ip}: ${err.message}`)
                    e.diagnosis = {
                        reason: err.diagnosis?.reason || 'PREFLIGHT_FAILED',
                        message: `[${node.ip}] ${err.diagnosis?.reason ? err.diagnosis.message : err.message.slice(0, 500)} Nothing was changed — the cluster is still on v${cluster.k8sVersion}.`,
                        suggestedFix: err.diagnosis?.suggestedFix || 'Check the log above, fix the node, then retry.',
                        fixAction: 'retry_step'
                    }
                    throw e
                } finally {
                    ssh.dispose?.()
                }
            }
            onLog('success', '✓ All nodes passed preflight — starting the upgrade.')
            report(PREFLIGHT_END, 'Preflight passed — starting the upgrade...')

            let firstMasterUpgraded = false

            for (let i = 0; i < allNodes.length; i++) {
                const node = allNodes[i]
                const nodeStart = PREFLIGHT_END + nodeSpan * i
                const nodeLabel = `Node ${i + 1}/${allNodes.length} · ${node.ip} (${node.role})`
                report(nodeStart, `${nodeLabel}: starting...`)

                onLog('info', `--------------------------------------------------`)
                onLog('info', `Processing Node: ${node.ip} (${node.role})`)

                const ssh = await this.connectSSH(node)

                try {
                    // Determine flags
                    // $1=TARGET_VERSION, $2=ROLE, $3=IS_FIRST_MASTER
                    const isFirstMaster = (node.role === 'master' && !firstMasterUpgraded)
                    const args = [targetVersion, node.role, isFirstMaster ? 'true' : 'false']

                    onLog('info', `Step: Upgrading node components...`)
                    // Long-running: apt/yum + image pulls + kubeadm (with one internal
                    // retry) + waiting for Ready can exceed the default relay timeout.
                    const scriptOpts = {
                        timeoutMs: 45 * 60 * 1000,
                        // Script stage (0-100 on this node) → this node's slice of the bar
                        onStageProgress: (pct, label) => report(nodeStart + (nodeSpan * pct) / 100, `${nodeLabel}: ${label}`)
                    }
                    try {
                        await this.executeScript(ssh, scriptPath, args, onLog, scriptOpts)
                    } catch (err) {
                        // Auto-heal: if the failure is a broken/EOL OS repo, fix it and retry once
                        const diag = err.diagnosis?.fixAction
                        const msg = err.message || ''
                        const isRepoIssue = diag === 'fix_centos7_repos' || diag === 'fix_ipv6_force' || diag === 'fix_dns_resolv'
                            || /vault\.centos\.org|no more mirrors|403 - forbidden|could not resolve/i.test(msg)
                        // RPM DB corruption (Berkeley DB) / package-manager crash
                        const isRpmDbIssue = /rpmdb|BDB\d|DB_RUNRECOVERY|bus error|core dumped|rpmdb open failed/i.test(msg)
                        if (!isRepoIssue && !isRpmDbIssue) throw err

                        if (isRpmDbIssue) {
                            onLog('warning', `⚠️ RPM database corruption detected on ${node.ip}. The script will rebuild it and retry...`)
                        } else {
                            onLog('warning', `⚠️ Repository issue detected on ${node.ip}. Auto-healing OS repos and retrying...`)
                            await this.runFix('fix_centos7_repos', node, onLog)
                        }
                        onLog('info', `Retrying upgrade on ${node.ip}...`)
                        // Re-running the script re-runs its built-in RPM DB recovery first
                        await this.executeScript(ssh, scriptPath, args, onLog, scriptOpts)
                    }

                    if (isFirstMaster) firstMasterUpgraded = true

                    onLog('success', `✓ Node ${node.ip} upgraded successfully`)
                    report(nodeStart + nodeSpan, `${nodeLabel}: upgraded ✓`)

                } catch (err) {
                    onLog('error', `❌ Upgrade failed on node ${node.ip}: ${err.message}`)
                    const e = new Error(`Upgrade failed on ${node.ip}: ${err.message}`)
                    // Keep the diagnosis so the failure screen shows reason + fix
                    e.diagnosis = err.diagnosis && err.diagnosis.reason !== 'Unknown execution error'
                        ? { ...err.diagnosis, message: `[${node.ip} · ${node.role}] ${err.diagnosis.message}` }
                        : {
                            reason: 'UPGRADE_FAILED',
                            message: `[${node.ip} · ${node.role}] ${String(err.message).slice(-500)}`,
                            suggestedFix: err.diagnosis?.suggestedFix || 'Check the log above for the exact error, fix it on the node, then retry.',
                            fixAction: 'retry_step'
                        }
                    throw e
                } finally {
                    ssh.dispose()
                }
            }

            onProgress(100, 'Cluster upgrade complete')
            onLog('success', `✅ Cluster successfully upgraded to v${targetVersion}`)
            // FIX: Must update 'k8sVersion' property to correctly persist changes in clusterStore
            onComplete({ ...cluster, k8sVersion: targetVersion })

        } catch (error) {
            onLog('error', `❌ Upgrade process terminated: ${error.message}`)
            onError(error)
        }
    }

    validateUpgradePath(currentVersion, targetVersion) {
        // Parse "1.28.2" -> [1, 28, 2]
        const parse = (v) => v.split('.').map(Number)
        const [cMajor, cMinor] = parse(currentVersion)
        const [tMajor, tMinor] = parse(targetVersion)

        if (cMajor !== tMajor) {
            throw new Error(`Major version upgrades (v${cMajor} -> v${tMajor}) are not supported automatically.`)
        }

        if (tMinor < cMinor) {
            throw new Error(`Downgrades are not supported (v${currentVersion} -> v${targetVersion}).`)
        }

        if (tMinor > cMinor + 1) {
            throw new Error(`Skip-level upgrades are unsafe (v${currentVersion} -> v${targetVersion}). Please upgrade to v${cMajor}.${cMinor + 1} first.`)
        }

        if (tMinor === cMinor && parse(targetVersion)[2] <= parse(currentVersion)[2]) {
            // Re-installing same version is technically fine (idempotent), but warn
            // actually, patch downgrades are bad too.
            if (parse(targetVersion)[2] < parse(currentVersion)[2])
                throw new Error(`Patch version downgrade not supported.`)
        }

        return true
    }

    // ─── Resume: skip completed steps, run only what's missing ──────────────
    async resume(cluster, analysis, callbacks) {
        const { onProgress, onLog, onComplete, onError } = callbacks
        const { resumeFromStep, missingWorkers } = analysis

        const STEP_ORDER = [
            'installContainerRuntime',
            'installKubernetesComponents',
            'initializeControlPlane',
            'installNetworkPlugin',
            'joinNodes',
            'installAddons',
            'postValidation'
        ]

        const STEP_PROGRESS = {
            installContainerRuntime:    20,
            installKubernetesComponents: 35,
            initializeControlPlane:     50,
            installNetworkPlugin:       65,
            joinNodes:                  75,
            installAddons:             85,
            postValidation:            95
        }

        // Start at the first unfinished step, and also skip any LATER step the
        // analysis found already done (e.g. CNI failed earlier but workers have
        // joined since) — re-running those would re-join nodes or reinstall.
        const doneSteps = new Set((analysis.checks || []).filter(c => c.done).map(c => c.key))
        const startIdx = STEP_ORDER.indexOf(resumeFromStep)
        const steps = STEP_ORDER.slice(startIdx >= 0 ? startIdx : 0)
            .filter(s => s === resumeFromStep || s === 'postValidation' || !doneSteps.has(s))

        // Resume always runs on real nodes. Inject ownerId/orgId so SSH routes
        // through the tenant's Gateway Agent (stored nodes don't carry them).
        const enrich = (n) => ({ ...n, ownerId: cluster.ownerId, orgId: cluster.orgId })
        cluster = {
            ...cluster,
            simulationMode: false,
            masterNodes: (cluster.masterNodes || []).map(enrich),
            workerNodes: (cluster.workerNodes || []).map(enrich)
        }

        try {
            onLog('info', `▶ Resuming installation from: ${resumeFromStep}`)
            onLog('info', `Steps to run: ${steps.join(' → ')}`)
            onProgress(5, 'Starting resume...')

            let joinCommand = null

            for (const step of steps) {
                onProgress(STEP_PROGRESS[step] ?? 50, `Running: ${step}...`)

                switch (step) {

                    case 'installContainerRuntime':
                        onLog('info', 'Installing container runtime...')
                        await this.installContainerRuntime(cluster, onLog)
                        break

                    case 'installKubernetesComponents':
                        onLog('info', 'Installing Kubernetes components...')
                        await this.installKubernetesComponents(cluster, onLog)
                        break

                    case 'initializeControlPlane':
                        onLog('info', 'Initializing control plane...')
                        joinCommand = await this.initializeControlPlane(cluster, onLog)
                        break

                    case 'installNetworkPlugin':
                        // Regenerate fresh join token if CP was already done before this resume
                        if (!joinCommand) {
                            joinCommand = await this._regenerateJoinCommand(cluster, onLog)
                        }
                        onLog('info', 'Installing network plugin...')
                        await this.installNetworkPlugin(cluster, onLog)
                        break

                    case 'joinNodes': {
                        if (!joinCommand) {
                            joinCommand = await this._regenerateJoinCommand(cluster, onLog)
                        }
                        // Only workers the analysis found missing — never re-join a
                        // node that is already in the cluster.
                        const workersToJoin = Array.isArray(missingWorkers)
                            ? missingWorkers
                            : (cluster.workerNodes || [])
                        if (workersToJoin.length === 0) {
                            onLog('info', 'All nodes already joined — skipping')
                        } else {
                            onLog('info', `Joining ${workersToJoin.length} missing worker node(s)...`)
                            const partialInstallation = { ...cluster, masterNodes: [], workerNodes: workersToJoin }
                            await this.joinNodes(partialInstallation, joinCommand, onLog)
                        }
                        break
                    }

                    case 'installAddons': {
                        // Only the add-ons that are not healthy yet
                        // (analysis comes from the client — only add-ons configured on this cluster)
                        const pending = Array.isArray(analysis.pendingAddons)
                            ? analysis.pendingAddons.filter(k => cluster.addons?.[k])
                            : null
                        const addons = Array.isArray(pending)
                            ? Object.fromEntries(pending.map(k => [k, true]))
                            : cluster.addons
                        if (Array.isArray(pending)) {
                            onLog('info', pending.length
                                ? `Installing add-ons not finished yet: ${pending.join(', ')}`
                                : 'All add-ons already running — skipping')
                        } else {
                            onLog('info', 'Installing add-ons...')
                        }
                        await this.installAddons({ ...cluster, addons }, onLog)
                        break
                    }

                    case 'postValidation':
                        onLog('info', 'Running post-installation validation...')
                        await this.postInstallationValidation(cluster, onLog)
                        break
                }

                onLog('success', `✓ ${step} complete`)
            }

            onProgress(100, 'Resume completed!')
            onLog('success', '✅ Cluster installation resumed and completed successfully!')

            const clusterInfo = {
                name: cluster.clusterName,
                version: cluster.k8sVersion,
                nodes: [
                    ...cluster.masterNodes.map(n => ({
                        name: n.hostname || `master-${n.ip}`,
                        ip: n.ip, role: 'master', status: 'Ready'
                    })),
                    ...(cluster.workerNodes || []).map(n => ({
                        name: n.hostname || `worker-${n.ip}`,
                        ip: n.ip, role: 'worker', status: 'Ready'
                    }))
                ],
                nodeCount: cluster.masterNodes.length + (cluster.workerNodes?.length || 0),
                endpoint: `https://${cluster.masterNodes[0].ip}:6443`,
                simulationMode: false
            }

            onComplete(clusterInfo)

        } catch (error) {
            onLog('error', `❌ Resume failed: ${error.message}`)
            onError(error)
        }
    }

    // Regenerate a fresh kubeadm join token (existing token may have expired)
    async _regenerateJoinCommand(cluster, onLog) {
        onLog('info', 'Generating fresh join token...')
        const masterNode = cluster.masterNodes[0]
        const ssh = await this.connectSSH(masterNode)
        try {
            const joinResult = await ssh.execCommand(
                'sudo kubeadm token create --print-join-command 2>/dev/null'
            )
            const certResult = await ssh.execCommand(
                'sudo kubeadm init phase upload-certs --upload-certs 2>/dev/null | tail -1'
            )
            if (!joinResult.stdout?.trim()) {
                throw new Error('Could not generate join token — is the cluster control plane running?')
            }
            onLog('success', '✓ Fresh join token generated')
            return {
                joinCommand: joinResult.stdout.trim(),
                certKey: certResult.stdout.trim()
            }
        } finally {
            ssh.dispose?.()
        }
    }
}

export const automationEngine = new AutomationEngine()
