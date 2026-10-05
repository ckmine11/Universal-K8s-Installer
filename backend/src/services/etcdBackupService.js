import { automationEngine } from './automationEngine.js'
import { computePreview } from './restorePreview.js'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BK_DIR = '/var/lib/etcd-backup'

// Snapshots are kept for this many days (the newest one is always kept).
// Snapshots are taken only on demand ("Backup Now"), automatically before
// every upgrade and before every restore — there is no scheduled snapshot.
export const ETCD_RETENTION_DAYS = 45

// Node-side tools: snapshots + retention, and offsite (S3/MinIO) copies.
const NODE_TOOLS = {
    '/usr/local/sbin/kubeez-etcd-backup': 'etcd-backup-node.sh',
    '/usr/local/sbin/kubeez-etcd-offsite': 'etcd-offsite-node.sh'
}
const NODE_SCRIPT = '/usr/local/sbin/kubeez-etcd-backup'
const VERSION_FILE = '/etc/kubeez/etcd-backup.version'
const readTool = (file) => readFileSync(join(__dirname, '../automation', file), 'utf8').replace(/\r\n/g, '\n')
// Version = hash of the scripts + retention, so nodes update whenever they change.
const TOOL_VERSION = `r${ETCD_RETENTION_DAYS}-` + createHash('sha256')
    .update(Object.values(NODE_TOOLS).map(readTool).join('\0')).digest('hex').slice(0, 12)
const SCRIPT = (f) => join(__dirname, '../automation', f)

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
export const SNAPSHOT_RE = /^[A-Za-z0-9._-]+\.db$/

async function run(ssh, cmd, opts) {
    try {
        const r = await ssh.execCommand(cmd, opts)
        return { ok: r.code === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
    } catch (e) {
        return { ok: false, out: '', err: e.message }
    }
}

// pre-upgrade | pre-restore | manual | other — from the snapshot file name
export function snapshotType(filename) {
    if (/pre-upgrade/.test(filename)) return 'pre-upgrade'
    if (/pre-restore/.test(filename)) return 'pre-restore'
    if (/-manual-/.test(filename)) return 'manual'
    return 'other'
}

// Last "MEMBER_OK|x" / "MEMBER_FAIL|reason" line of etcd-member.sh
function memberResult(text) {
    const line = String(text || '').split('\n').reverse().find(l => /^MEMBER_(OK|FAIL)/.test(l.trim()))
    if (!line) return { ok: false, error: 'no answer from the node' }
    const [tag, ...rest] = line.trim().split('|')
    return tag === 'MEMBER_OK' ? { ok: true, info: rest.join('|') } : { ok: false, error: rest.join('|') }
}

class EtcdBackupService {
    firstMaster(cluster) {
        const m = cluster.masterNodes?.[0]
        if (!m) throw new Error('No master node found for this cluster')
        return m
    }

    /**
     * Install/update the snapshot tool on the primary control-plane.
     * Idempotent: does nothing when the installed version matches.
     */
    async ensureTool(ssh) {
        const check = await run(ssh, `sudo cat ${VERSION_FILE} 2>/dev/null`)
        if (check.out.includes(TOOL_VERSION)) return { installed: false }

        const cmd = [
            ...Object.entries(NODE_TOOLS).flatMap(([dest, file]) => [
                `echo ${b64(readTool(file))} | base64 -d | sudo tee ${dest} >/dev/null`,
                `sudo chmod 0755 ${dest}`
            ]),
            `sudo mkdir -p /etc/kubeez`,
            `echo ${TOOL_VERSION} | sudo tee ${VERSION_FILE} >/dev/null`
        ].join(' && ')
        const r = await run(ssh, cmd)
        if (!r.ok) throw new Error(`Could not install the etcd backup tools: ${r.err || r.out || 'unknown error'}`)
        return { installed: true }
    }

    /** List etcd snapshots on the primary control-plane (and apply retention). */
    async listBackups(cluster) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            // Retention is best-effort — listing must work even if it fails
            try {
                await this.ensureTool(ssh)
                await run(ssh, `sudo RETENTION_DAYS=${ETCD_RETENTION_DAYS} ${NODE_SCRIPT} prune`)
            } catch (e) {
                console.warn('[etcd] retention skipped:', e.message)
            }

            // "name|size|mtimeEpoch|verified" per snapshot; verified = has a checksum
            const r = await run(ssh,
                `sudo bash -c 'for f in ${BK_DIR}/*.db; do [ -e "$f" ] || continue; echo "$(basename "$f")|$(stat -c %s "$f")|$(stat -c %Y "$f")|$([ -f "$f.sha256" ] && echo 1)"; done'`)
            const backups = (r.out || '')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .map(line => {
                    const [filename, size, mtime, verified] = line.split('|')
                    const type = snapshotType(filename)
                    return {
                        filename,
                        size: parseInt(size) || 0,
                        created: new Date((parseInt(mtime) || 0) * 1000).toISOString(),
                        type,
                        auto: type === 'pre-upgrade' || type === 'pre-restore',
                        verified: verified === '1'
                    }
                })
                .sort((a, b) => new Date(b.created) - new Date(a.created))

            return { backups, node: master.ip, retentionDays: ETCD_RETENTION_DAYS }
        } finally {
            ssh.dispose?.()
        }
    }

    /** Take an on-demand etcd snapshot on the primary control-plane (verified + checksummed). */
    async createBackup(cluster) {
        const master = this.firstMaster(cluster)
        const ssh = await automationEngine.connectSSH(master)
        try {
            await this.ensureTool(ssh)
            // Uses host etcdctl (same version as the cluster's etcd) — the etcd
            // image is distroless, there is nothing to exec into.
            const r = await run(ssh, `sudo RETENTION_DAYS=${ETCD_RETENTION_DAYS} ${NODE_SCRIPT} manual`)
            if (r.ok && /SNAPSHOT_OK:/.test(r.out)) {
                const path = r.out.split('SNAPSHOT_OK:')[1]?.split('\n')[0]?.trim()
                const [rev, keys] = (r.out.split('VERIFIED:')[1]?.split('\n')[0] || '').split('|')
                return { success: true, filename: path?.split('/').pop(), path, verified: true, revision: parseInt(rev) || null, keys: parseInt(keys) || null }
            }
            return { success: false, error: (r.out || r.err || 'Snapshot failed').replace('SAVE_FAILED:', '').trim() }
        } finally {
            ssh.dispose?.()
        }
    }

    /** Checksum + etcd's own integrity check of one snapshot. */
    async verifyBackup(cluster, filename) {
        if (!SNAPSHOT_RE.test(filename || '')) throw Object.assign(new Error('Invalid snapshot name'), { status: 400 })
        const ssh = await automationEngine.connectSSH(this.firstMaster(cluster))
        try {
            await this.ensureTool(ssh)
            const r = await run(ssh, `sudo ${NODE_SCRIPT} verify ${filename}`)
            const line = r.out.split('\n').reverse().find(l => /^VERIFY_(OK|FAIL)\|/.test(l)) || ''
            if (line.startsWith('VERIFY_OK|')) {
                const [, rev, keys, size] = line.split('|')
                return { ok: true, revision: parseInt(rev) || null, keys: parseInt(keys) || null, size: parseInt(size) || null }
            }
            return { ok: false, error: line.split('|').slice(1).join('|') || r.err || 'The snapshot could not be checked' }
        } finally {
            ssh.dispose?.()
        }
    }

    /**
     * What a restore of `filename` would change: objects that disappear, come
     * back or are reverted. Reads the snapshot with a throw-away local etcd on
     * the control-plane — the cluster itself is not touched.
     */
    async previewRestore(cluster, filename) {
        if (!SNAPSHOT_RE.test(filename || '')) throw Object.assign(new Error('Invalid snapshot name'), { status: 400 })
        const ssh = await automationEngine.connectSSH(this.firstMaster(cluster))
        try {
            await this.ensureTool(ssh)
            const r = await ssh.execCommand(`sudo ${NODE_SCRIPT} keys ${filename}`, { timeoutMs: 5 * 60 * 1000 })
            return computePreview(`${r.stdout || ''}\n${r.stderr || ''}`)
        } finally {
            ssh.dispose?.()
        }
    }

    /**
     * After a restore, worker kubelets still remember pods created after the
     * snapshot and keep asking the API about them ("no relationship found
     * between node … and this object"). A kubelet restart makes them resync.
     * Best effort: an unreachable worker is reported, not fatal.
     */
    async refreshWorkerKubelets(cluster, onLog = () => {}) {
        const results = []
        for (const node of cluster.workerNodes || []) {
            let ssh
            try {
                ssh = await automationEngine.connectSSH(node)
                const r = await run(ssh, 'sudo systemctl restart kubelet')
                results.push({ ip: node.ip, ok: r.ok, error: r.ok ? null : (r.err || r.out) })
                onLog(r.ok ? 'info' : 'warning', r.ok
                    ? `[etcd-restore] ✓ kubelet restarted on worker ${node.ip}`
                    : `[etcd-restore] ⚠️ Could not restart kubelet on worker ${node.ip}: ${r.err || r.out} — use "Refresh workers" or run 'sudo systemctl restart kubelet' there.`)
            } catch (e) {
                results.push({ ip: node.ip, ok: false, error: e.message })
                onLog('warning', `[etcd-restore] ⚠️ Worker ${node.ip} unreachable (${e.message}) — use "Refresh workers" once it is back, or run 'sudo systemctl restart kubelet' there.`)
            } finally {
                ssh?.dispose?.()
            }
        }
        return results
    }

    // Run etcd-member.sh on a node → { ok, info | error }
    async _member(node, args, onLog) {
        let ssh
        try {
            ssh = await automationEngine.connectSSH(node)
            const lines = []
            try {
                await automationEngine.executeScript(ssh, SCRIPT('etcd-member.sh'), args, (lvl, m) => {
                    lines.push(m)
                    if (/^\[etcd-member\]/.test(m)) onLog('info', `${node.ip}: ${m}`)
                })
            } catch (e) { lines.push(e.message) }
            return memberResult(lines.join('\n'))
        } catch (e) {
            return { ok: false, error: `cannot connect to ${node.ip}: ${e.message}` }
        } finally {
            ssh?.dispose?.()
        }
    }

    /**
     * Restore etcd from a snapshot. Single control-plane: etcd-restore.sh does
     * everything (checks, safety snapshot, automatic rollback). HA: the other
     * control-planes are stopped first, the first one is restored as a single
     * etcd member, then the others re-join it one by one with empty data.
     */
    async restoreBackup(cluster, filename, onLog = () => {}, onProgress = () => {}) {
        if (!SNAPSHOT_RE.test(filename || '')) throw Object.assign(new Error('Invalid snapshot name'), { status: 400 })
        const [master, ...others] = cluster.masterNodes || []
        if (!master) throw new Error('No master node found for this cluster')
        const ha = others.length > 0
        const warnings = []
        let safetySnapshot = null

        const ssh = await automationEngine.connectSSH(master)
        try {
            await this.ensureTool(ssh)

            // ── HA: everything that can fail is checked BEFORE anything stops ──
            const members = []
            if (ha) {
                onProgress(3, 'Checking every control-plane')
                for (const n of [master, ...others]) {
                    const r = await this._member(n, ['info'], onLog)
                    const [name, peer] = (r.info || '').split('|')
                    if (!r.ok || !name || !peer) throw new Error(`Control-plane ${n.ip} is not ready for a restore: ${r.error || 'no etcd member found'}. Nothing was changed.`)
                    members.push({ node: n, name, peer })
                }
                onLog('info', `[etcd-restore] HA cluster: ${members.length} etcd members (${members.map(m => m.name).join(', ')})`)
                const v = await run(ssh, `sudo ${NODE_SCRIPT} verify ${filename}`)
                if (!/VERIFY_OK\|/.test(v.out)) throw new Error(`The snapshot is damaged: ${(v.out.split('VERIFY_FAIL|')[1] || v.err || 'unreadable').trim()}. Nothing was changed.`)
                onLog('info', '[etcd-restore] ✓ Snapshot verified')
                onProgress(8, 'Taking a safety snapshot of the current state')
                const s = await run(ssh, `sudo ${NODE_SCRIPT} prerestore`)
                safetySnapshot = (s.out.match(/SNAPSHOT_OK:(\S+)/)?.[1] || '').split('/').pop() || null
                onLog(safetySnapshot ? 'info' : 'warning', safetySnapshot
                    ? `[etcd-restore] ✓ Safety snapshot of the current state: ${safetySnapshot}`
                    : `[etcd-restore] ⚠️ Could not take a safety snapshot (${s.out.split('\n').pop() || s.err}) — continuing; each node keeps its current data as a rollback copy.`)

                onProgress(12, 'Stopping the other control-planes')
                const stopped = []
                for (const m of members.slice(1)) {
                    const r = await this._member(m.node, ['stop'], onLog)
                    if (!r.ok) {
                        for (const s2 of stopped) await this._member(s2.node, ['start'], onLog)
                        throw new Error(`Could not stop the control plane on ${m.node.ip}: ${r.error}. Nothing was restored; the cluster is unchanged.`)
                    }
                    stopped.push(m)
                    onLog('info', `[etcd-restore] ✓ Control plane stopped on ${m.node.ip}`)
                }
            }

            // ── Restore on the first control-plane ──
            const seen = new Set()
            let scriptError = null
            try {
                await automationEngine.executeScript(ssh, SCRIPT('etcd-restore.sh'), ha ? [filename, '--no-safety'] : [filename], (lvl, m) => {
                    if (/STEP=|RESULT=/.test(m)) return
                    seen.add(m.trim()); onLog(lvl, m)
                }, { onStageProgress: (pct, label) => onProgress(ha ? 15 + Math.round(pct * 0.55) : pct, label) })
            } catch (e) {
                // The control-plane restart can drop the SSH stream mid-run — don't
                // trust the stream alone; the log file on the node is authoritative.
                scriptError = e
            }

            // Read the full log back from the node (survives stream drops)
            let logText = ''
            try {
                const r = await ssh.execCommand(`sudo cat ${BK_DIR}/last-restore.log 2>/dev/null`)
                logText = (r.stdout || '').trim()
            } catch { /* ignore */ }
            for (const line of logText.split('\n')) {
                if (!line.trim() || /RESULT=|STEP=/.test(line) || seen.has(line.trim())) continue
                onLog(/❌|error|fail/i.test(line) ? 'warning' : 'info', line)
            }
            safetySnapshot = safetySnapshot || logText.match(/SAFETY_SNAPSHOT=(\S+)/)?.[1] || null

            if (!/RESULT=OK/.test(logText)) {
                if (ha) {
                    // The first control-plane runs on its old data again (rolled
                    // back) — the others still have theirs: just start them.
                    for (const m of members.slice(1)) {
                        const r = await this._member(m.node, ['start'], onLog)
                        onLog(r.ok ? 'info' : 'warning', r.ok ? `[etcd-restore] ✓ Control plane started again on ${m.node.ip}` : `[etcd-restore] ⚠️ ${m.node.ip}: ${r.error}`)
                    }
                }
                const reason = /RESULT=FAILED/.test(logText)
                    ? (logText.split('\n').reverse().find(l => l.includes('❌')) || 'etcd restore failed')
                    : (scriptError?.message?.trim() || 'etcd restore did not complete (no result marker). Check the node log /var/lib/etcd-backup/last-restore.log')
                throw Object.assign(new Error(reason.replace('[etcd-restore] ❌', '').trim()), { result: { safetySnapshot } })
            }

            // ── HA: the other control-planes re-join the restored etcd ──
            if (ha) {
                const joined = [members[0]]
                let i = 0
                for (const m of members.slice(1)) {
                    onProgress(72 + Math.round((i++ / (members.length - 1)) * 15), `Re-joining ${m.node.ip} to the restored etcd`)
                    const add = await this._member(master, ['add', m.name, m.peer], onLog)
                    const rejoin = add.ok
                        ? await this._member(m.node, ['rejoin', ...[...joined, m].flatMap(x => [x.name, x.peer])], onLog)
                        : add
                    if (rejoin.ok) {
                        joined.push(m)
                        onLog('info', `[etcd-restore] ✓ ${m.node.ip} (${m.name}) re-joined the restored etcd`)
                    } else {
                        if (add.ok) await this._member(master, ['remove', m.name, m.peer], onLog)
                        const w = `${m.node.ip} could not re-join etcd: ${rejoin.error}. The cluster runs without it — re-add it with "Add node" (control-plane) or restore again.`
                        warnings.push(w); onLog('warning', `[etcd-restore] ⚠️ ${w}`)
                    }
                }
            }

            onProgress(90, 'Refreshing kubelets on the workers')
            const workers = await this.refreshWorkerKubelets(cluster, onLog)
            const unreachable = workers.filter(w => !w.ok).map(w => w.ip)
            if (unreachable.length) warnings.push(`Kubelet not refreshed on ${unreachable.join(', ')} — use "Refresh workers" once they are reachable.`)
            return { success: true, safetySnapshot, warnings, unrefreshedWorkers: unreachable }
        } finally {
            ssh.dispose?.()
        }
    }
}

export const etcdBackupService = new EtcdBackupService()
