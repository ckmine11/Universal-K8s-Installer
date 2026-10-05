import { automationEngine } from './automationEngine.js'
import { etcdBackupService } from './etcdBackupService.js'
import { offsiteService } from './offsiteService.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = (f) => join(__dirname, '../automation', f)

/**
 * Rebuild a LOST control-plane from an offsite backup bundle.
 *
 * For when the control-plane machine itself is gone (disk failure, deleted VM):
 * the user brings up a fresh machine with the SAME IP and login, and KubeEZ
 *   1. prepares it like a new node (preflight, firewall, containerd),
 *   2. downloads + decrypts the offsite bundle onto it,
 *   3. installs the Kubernetes version the backup was taken on,
 *   4. restores the certificate authorities + etcd and runs kubeadm around them
 *      (recover-control-plane.sh) — workers reconnect on their own,
 *   5. re-joins any other control-plane that is still reachable (HA).
 */
class DisasterRecovery {
    async recover(cluster, target, snapshot, onLog = () => {}, onProgress = () => {}) {
        const [master, ...others] = cluster.masterNodes || []
        if (!master) throw new Error('No control-plane node in this cluster')
        const step = async (ssh, file, args, label, from, to) => {
            onProgress(from, label)
            onLog('info', `── ${label}`)
            await automationEngine.executeScript(ssh, SCRIPT(file), args, onLog,
                { onStageProgress: (pct, l) => onProgress(from + Math.round((pct / 100) * (to - from)), l || label) })
        }

        onProgress(2, `Connecting to ${master.ip}`)
        let ssh
        try {
            ssh = await automationEngine.connectSSH(master)
        } catch (e) {
            throw new Error(`Cannot connect to ${master.ip}: ${e.message}. Bring up the replacement machine with the same IP and login (or update them in the cluster settings) first.`)
        }
        try {
            const live = await ssh.execCommand('sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get --raw=/readyz 2>/dev/null')
            if ((live.stdout || '').trim() === 'ok') {
                throw new Error('The control plane on this machine is running — recovery is only for a lost/rebuilt control-plane. To roll the cluster back, use Restore instead.')
            }
            const hn = await ssh.execCommand('hostname')
            onLog('info', `Recovering the control-plane on ${master.ip} (${(hn.stdout || '').trim()}) from offsite backup ${snapshot}`)

            await step(ssh, 'preflight-checks.sh', [], 'Checking the machine', 5, 12)
            await step(ssh, 'configure-firewall.sh', ['master'], 'Opening the control-plane ports', 12, 18)

            onProgress(20, 'Downloading the offsite backup')
            onLog('info', '── Downloading + decrypting the offsite backup')
            const dl = await offsiteService.download(cluster, target, snapshot, { recovery: true })
            if (!dl.ok) throw new Error(`Could not fetch the offsite backup: ${dl.error}`)
            const kver = (dl.kubeadm || '').replace(/^v/, '') || cluster.k8sVersion
            const minor = String(kver || '').split('.').slice(0, 2).join('.')
            if (!/^\d+\.\d+$/.test(minor)) throw new Error('The backup does not say which Kubernetes version it was taken on, and the cluster record has none either.')
            onLog('info', `✓ Backup downloaded — taken on Kubernetes v${kver}`)

            await step(ssh, 'install-containerd.sh', [], 'Installing containerd', 25, 40)
            await step(ssh, 'install-kubernetes.sh', [minor], `Installing Kubernetes v${minor}`, 40, 55)
            await step(ssh, 'recover-control-plane.sh', [master.ip], 'Rebuilding the control plane from the backup', 55, 85)
            onLog('info', '✓ Control plane recovered')
        } finally {
            ssh?.dispose?.()
        }

        // Other control-planes still alive (HA): their etcd belongs to the old
        // cluster — re-join them to the recovered one, like after a restore.
        const warnings = []
        if (others.length) {
            onProgress(88, 'Re-joining the other control-planes')
            const info = await etcdBackupService._member(master, ['info'], onLog)
            const [name, peer] = (info.info || '').split('|')
            const joined = [{ name, peer }]
            for (const n of others) {
                const i = await etcdBackupService._member(n, ['info'], onLog)
                const [mn, mp] = (i.info || '').split('|')
                if (!i.ok || !mn) { warnings.push(`${n.ip} is unreachable or has no control plane — re-add it with "Add node".`); continue }
                const stop = await etcdBackupService._member(n, ['stop'], onLog)
                const add = stop.ok ? await etcdBackupService._member(master, ['add', mn, mp], onLog) : stop
                const rj = add.ok ? await etcdBackupService._member(n, ['rejoin', ...[...joined, { name: mn, peer: mp }].flatMap(x => [x.name, x.peer])], onLog) : add
                if (rj.ok) { joined.push({ name: mn, peer: mp }); onLog('info', `✓ ${n.ip} re-joined`) }
                else {
                    if (add.ok) await etcdBackupService._member(master, ['remove', mn, mp], onLog)
                    warnings.push(`${n.ip} could not re-join: ${rj.error} — re-add it with "Add node".`)
                }
            }
        }

        onProgress(94, 'Refreshing kubelets on the workers')
        const workers = await etcdBackupService.refreshWorkerKubelets(cluster, onLog)
        const unreachable = workers.filter(w => !w.ok).map(w => w.ip)
        if (unreachable.length) warnings.push(`Kubelet not refreshed on ${unreachable.join(', ')} — use "Refresh workers" once they are reachable.`)
        warnings.forEach(w => onLog('warning', `⚠️ ${w}`))
        return { success: true, warnings }
    }
}

export const disasterRecovery = new DisasterRecovery()
