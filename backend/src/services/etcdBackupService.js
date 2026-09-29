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
            // Use HOST etcdctl (with an explicit PATH so /usr/local/bin is found,
            // and a download fallback). The old pod-exec path used `sh -c`, which
            // fails on the distroless etcd image ("sh: not found").
            const cmd = `sudo bash -c '
export PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH
BK=${BK_DIR}; mkdir -p "$BK"
SNAP="$BK/etcd-manual-$(date +%Y%m%d-%H%M%S).db"
C="${ETCD_CERTS}"
if ! command -v etcdctl >/dev/null 2>&1; then
  EV=$(grep -oE "etcd:[0-9]+\\.[0-9]+\\.[0-9]+" /etc/kubernetes/manifests/etcd.yaml 2>/dev/null | head -1 | cut -d: -f2)
  [ -z "$EV" ] && EV=3.5.16
  A=amd64; [ "$(uname -m)" = "aarch64" ] && A=arm64
  curl -fsSL --retry 3 -m 120 "https://github.com/etcd-io/etcd/releases/download/v$EV/etcd-v$EV-linux-$A.tar.gz" -o /tmp/etcd.tgz 2>/dev/null && \
    tar xzf /tmp/etcd.tgz -C /tmp 2>/dev/null && \
    install -m0755 /tmp/etcd-v$EV-linux-$A/etcdctl /usr/local/bin/etcdctl 2>/dev/null
fi
command -v etcdctl >/dev/null 2>&1 || { echo "NO_ETCDCTL: could not find or download etcdctl"; exit 1; }
if ETCDCTL_API=3 etcdctl $C snapshot save "$SNAP" >/tmp/etcd-save.log 2>&1; then
  echo "SNAPSHOT_OK:$SNAP"
else
  echo "SAVE_FAILED:"; cat /tmp/etcd-save.log; exit 1
fi
'`
            const r = await run(ssh, cmd)
            if (r.ok && /SNAPSHOT_OK:/.test(r.out)) {
                const path = r.out.split('SNAPSHOT_OK:')[1]?.trim()
                return { success: true, filename: path?.split('/').pop(), path }
            }
            return { success: false, error: (r.out || r.err || 'Snapshot failed').replace('SAVE_FAILED:', '').trim() }
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
