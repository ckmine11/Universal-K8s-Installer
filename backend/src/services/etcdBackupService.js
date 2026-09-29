import { automationEngine } from './automationEngine.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BK_DIR = '/var/lib/etcd-backup'
const ETCD_CERTS = '--cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key --endpoints=https://127.0.0.1:2379'

async function run(ssh, cmd) {
    try {
        const r = await ssh.execCommand(cmd)
        return { ok: r.code === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
    } catch (e) {
        return { ok: false, out: '', err: e.message }
    }
}

class EtcdBackupService {
    firstMaster(cluster) {
        const m = cluster.masterNodes?.[0]
        if (!m) throw new Error('No master node found for this cluster')
        return m
    }

    /** List etcd snapshots present on the primary control-plane. */
    async listBackups(cluster) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            // Emit "name|size|mtimeEpoch" per snapshot for easy parsing.
            const r = await run(ssh,
                `sudo bash -c 'for f in ${BK_DIR}/*.db; do [ -e "$f" ] || continue; echo "$(basename "$f")|$(stat -c %s "$f")|$(stat -c %Y "$f")"; done'`)
            const backups = (r.out || '')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .map(line => {
                    const [filename, size, mtime] = line.split('|')
                    return {
                        filename,
                        size: parseInt(size) || 0,
                        created: new Date((parseInt(mtime) || 0) * 1000).toISOString(),
                        auto: /pre-upgrade/.test(filename)   // taken automatically before an upgrade
                    }
                })
                .sort((a, b) => new Date(b.created) - new Date(a.created))
            return { backups, node: master.ip }
        } finally {
            ssh.dispose?.()
        }
    }

    /** Take an on-demand etcd snapshot on the primary control-plane. */
    async createBackup(cluster) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            const cmd = `sudo bash -c '
set -e
BK=${BK_DIR}; mkdir -p "$BK"
SNAP="$BK/etcd-manual-$(date +%Y%m%d-%H%M%S).db"
C="${ETCD_CERTS}"
if command -v etcdctl >/dev/null 2>&1; then
  ETCDCTL_API=3 etcdctl $C snapshot save "$SNAP" >/dev/null
else
  KC="--kubeconfig=/etc/kubernetes/admin.conf"
  POD=$(kubectl $KC -n kube-system get pods -l component=etcd -o jsonpath="{.items[0].metadata.name}")
  [ -n "$POD" ] || { echo "NO_ETCD_POD"; exit 1; }
  kubectl $KC -n kube-system exec "$POD" -- sh -c "ETCDCTL_API=3 etcdctl $C snapshot save /var/lib/etcd/kubeez-manual.db" >/dev/null
  mv -f /var/lib/etcd/kubeez-manual.db "$SNAP"
fi
echo "SNAPSHOT_OK:$SNAP"
'`
            const r = await run(ssh, cmd)
            if (r.ok && /SNAPSHOT_OK:/.test(r.out)) {
                const path = r.out.split('SNAPSHOT_OK:')[1]?.trim()
                return { success: true, filename: path?.split('/').pop(), path }
            }
            return { success: false, error: r.err || r.out || 'Snapshot failed' }
        } finally {
            ssh.dispose?.()
        }
    }

    /**
     * Restore etcd from a snapshot on the primary control-plane.
     * Runs the multi-step kubeadm restore script; streams progress via onLog.
     * Only supported for single control-plane clusters (see route guard).
     */
    async restoreBackup(cluster, filename, onLog = () => {}) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            const scriptPath = join(__dirname, '../automation/etcd-restore.sh')
            await automationEngine.executeScript(ssh, scriptPath, [filename], onLog)
            return { success: true }
        } finally {
            ssh.dispose?.()
        }
    }
}

export const etcdBackupService = new EtcdBackupService()
