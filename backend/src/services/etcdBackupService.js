import { automationEngine } from './automationEngine.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BK_DIR = '/var/lib/etcd-backup'

// Snapshots are kept for this many days (the newest one is always kept).
export const ETCD_RETENTION_DAYS = 45

// Node-side tooling: one script for daily + manual snapshots and retention,
// run daily by a systemd timer so backups continue even if KubeEZ is offline.
const NODE_SCRIPT = '/usr/local/sbin/kubeez-etcd-backup'
const UNIT = 'kubeez-etcd-backup'
const VERSION_FILE = '/etc/kubeez/etcd-backup.version'
// Bump when the script or units change so existing nodes get updated.
const SCHEDULE_VERSION = `v1-r${ETCD_RETENTION_DAYS}`

const SERVICE_UNIT = `[Unit]
Description=KubeEZ etcd snapshot (keeps ${ETCD_RETENTION_DAYS} days)
After=network-online.target

[Service]
Type=oneshot
Environment=RETENTION_DAYS=${ETCD_RETENTION_DAYS}
ExecStart=${NODE_SCRIPT} daily
`
const TIMER_UNIT = `[Unit]
Description=Daily KubeEZ etcd snapshot

[Timer]
OnCalendar=*-*-* 02:00:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
`

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')

async function run(ssh, cmd) {
    try {
        const r = await ssh.execCommand(cmd)
        return { ok: r.code === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
    } catch (e) {
        return { ok: false, out: '', err: e.message }
    }
}

// pre-upgrade | daily | manual | other — from the snapshot file name
function snapshotType(filename) {
    if (/pre-upgrade/.test(filename)) return 'pre-upgrade'
    if (/-daily-/.test(filename)) return 'daily'
    if (/-manual-/.test(filename)) return 'manual'
    return 'other'
}

class EtcdBackupService {
    firstMaster(cluster) {
        const m = cluster.masterNodes?.[0]
        if (!m) throw new Error('No master node found for this cluster')
        return m
    }

    /**
     * Install/update the snapshot script + daily systemd timer on the primary
     * control-plane. Idempotent: does nothing when the installed version matches.
     */
    async ensureSchedule(ssh) {
        const check = await run(ssh, `sudo cat ${VERSION_FILE} 2>/dev/null; systemctl is-enabled ${UNIT}.timer 2>/dev/null`)
        if (check.out.includes(SCHEDULE_VERSION) && /\benabled\b/.test(check.out)) return { installed: false }

        const script = readFileSync(join(__dirname, '../automation/etcd-backup-node.sh'), 'utf8').replace(/\r\n/g, '\n')
        const cmd = [
            `echo ${b64(script)} | base64 -d | sudo tee ${NODE_SCRIPT} >/dev/null`,
            `sudo chmod 0755 ${NODE_SCRIPT}`,
            `echo ${b64(SERVICE_UNIT)} | base64 -d | sudo tee /etc/systemd/system/${UNIT}.service >/dev/null`,
            `echo ${b64(TIMER_UNIT)} | base64 -d | sudo tee /etc/systemd/system/${UNIT}.timer >/dev/null`,
            `sudo mkdir -p /etc/kubeez`,
            `echo ${SCHEDULE_VERSION} | sudo tee ${VERSION_FILE} >/dev/null`,
            `sudo systemctl daemon-reload`,
            `sudo systemctl enable --now ${UNIT}.timer`
        ].join(' && ')
        const r = await run(ssh, cmd)
        if (!r.ok) throw new Error(`Could not set up daily etcd backups: ${r.err || r.out || 'unknown error'}`)
        return { installed: true }
    }

    /** Connect to the primary control-plane and make sure daily backups are on. */
    async ensureScheduleForCluster(cluster) {
        const ssh = await automationEngine.connectSSH(this.firstMaster(cluster))
        try {
            return await this.ensureSchedule(ssh)
        } finally {
            ssh.dispose?.()
        }
    }

    /** List etcd snapshots on the primary control-plane (and apply retention). */
    async listBackups(cluster) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            let scheduleError = null
            try {
                await this.ensureSchedule(ssh)
                await run(ssh, `sudo RETENTION_DAYS=${ETCD_RETENTION_DAYS} ${NODE_SCRIPT} prune`)
            } catch (e) {
                scheduleError = e.message   // listing still works without the schedule
            }

            // Emit "name|size|mtimeEpoch" per snapshot for easy parsing.
            const r = await run(ssh,
                `sudo bash -c 'for f in ${BK_DIR}/*.db; do [ -e "$f" ] || continue; echo "$(basename "$f")|$(stat -c %s "$f")|$(stat -c %Y "$f")"; done'`)
            const backups = (r.out || '')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .map(line => {
                    const [filename, size, mtime] = line.split('|')
                    const type = snapshotType(filename)
                    return {
                        filename,
                        size: parseInt(size) || 0,
                        created: new Date((parseInt(mtime) || 0) * 1000).toISOString(),
                        type,
                        auto: type !== 'manual'
                    }
                })
                .sort((a, b) => new Date(b.created) - new Date(a.created))

            // When will the next daily snapshot run? (epoch seconds from systemd)
            const t = await run(ssh, `t=$(systemctl show ${UNIT}.timer -p NextElapseUSecRealtime --value 2>/dev/null); [ -n "$t" ] && date -d "$t" +%s 2>/dev/null`)
            const nextEpoch = parseInt(t.out, 10)

            return {
                backups,
                node: master.ip,
                retentionDays: ETCD_RETENTION_DAYS,
                schedule: {
                    enabled: !scheduleError,
                    nextRun: nextEpoch > 0 ? new Date(nextEpoch * 1000).toISOString() : null,
                    error: scheduleError
                }
            }
        } finally {
            ssh.dispose?.()
        }
    }

    /** Take an on-demand etcd snapshot on the primary control-plane. */
    async createBackup(cluster) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            await this.ensureSchedule(ssh)
            // Uses host etcdctl (downloaded if missing) — the etcd image is
            // distroless, so exec-ing a shell inside the pod does not work.
            const r = await run(ssh, `sudo RETENTION_DAYS=${ETCD_RETENTION_DAYS} ${NODE_SCRIPT} manual`)
            if (r.ok && /SNAPSHOT_OK:/.test(r.out)) {
                const path = r.out.split('SNAPSHOT_OK:')[1]?.split('\n')[0]?.trim()
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
            let scriptError = null
            try {
                await automationEngine.executeScript(ssh, scriptPath, [filename], onLog)
            } catch (e) {
                // The control-plane restart can drop the SSH stream mid-run — don't
                // trust the stream alone; the log file on the node is authoritative.
                scriptError = e
            }

            // Read the full log back from the node (survives stream drops).
            let logText = ''
            try {
                const r = await ssh.execCommand('sudo cat /var/lib/etcd-backup/last-restore.log 2>/dev/null')
                logText = (r.stdout || '').trim()
            } catch { /* ignore */ }

            // Re-emit any log lines the stream missed, so the UI shows the full log.
            if (logText) {
                for (const line of logText.split('\n')) {
                    if (!line.trim() || line.includes('RESULT=')) continue
                    const level = /❌|error|fail/i.test(line) ? 'warning' : 'info'
                    onLog(level, line)
                }
            }

            const succeeded = /RESULT=OK/.test(logText)
            if (succeeded) return { success: true }

            const failedMarker = /RESULT=FAILED/.test(logText)
            const reason = failedMarker
                ? (logText.split('\n').reverse().find(l => l.includes('❌')) || 'etcd restore failed')
                : (scriptError?.message?.trim() || 'etcd restore did not complete (no result marker). Check the node log /var/lib/etcd-backup/last-restore.log')
            throw new Error(reason.replace('[etcd-restore] ❌', '').trim())
        } finally {
            ssh.dispose?.()
        }
    }
}

export const etcdBackupService = new EtcdBackupService()
