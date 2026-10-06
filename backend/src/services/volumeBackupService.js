import { automationEngine } from './automationEngine.js'

// Volume backups = Velero (installed by addons/velero.sh). KubeEZ drives it
// with the Velero CLI on the primary control-plane.
const KB = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'
const VEL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf velero'
export const SCHEDULE_NAME = 'kubeez-daily'
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const NS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const CRON_RE = /^[0-9*/,-]+( [0-9*/,-]+){4}$/

const bad = (msg) => Object.assign(new Error(msg), { status: 400 })

async function run(ssh, cmd) {
    try {
        const r = await ssh.execCommand(cmd)
        return { ok: r.code === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
    } catch (e) {
        return { ok: false, out: '', err: e.message }
    }
}
const items = (text) => { try { return JSON.parse(text).items || [] } catch { return [] } }

export function summarizeBackup(b) {
    const s = b.status || {}
    return {
        name: b.metadata?.name,
        phase: s.phase || 'New',
        namespaces: b.spec?.includedNamespaces?.length && !b.spec.includedNamespaces.includes('*') ? b.spec.includedNamespaces : ['*'],
        schedule: b.metadata?.labels?.['velero.io/schedule-name'] || null,
        started: s.startTimestamp || b.metadata?.creationTimestamp || null,
        completed: s.completionTimestamp || null,
        expires: s.expiration || null,
        items: s.progress ? { done: s.progress.itemsBackedUp || 0, total: s.progress.totalItems || 0 } : null,
        volumes: s.backupItemOperationsAttempted ?? null,
        errors: s.errors || 0,
        warnings: s.warnings || 0,
        failureReason: s.failureReason || null,
        validationErrors: s.validationErrors || []
    }
}

export function summarizeRestore(r) {
    const s = r.status || {}
    return {
        name: r.metadata?.name,
        backup: r.spec?.backupName,
        phase: s.phase || 'New',
        namespaces: r.spec?.includedNamespaces || ['*'],
        mappings: r.spec?.namespaceMapping || null,
        started: s.startTimestamp || r.metadata?.creationTimestamp || null,
        completed: s.completionTimestamp || null,
        items: s.progress ? { done: s.progress.itemsRestored || 0, total: s.progress.totalItems || 0 } : null,
        errors: s.errors || 0,
        warnings: s.warnings || 0,
        failureReason: s.failureReason || null,
        validationErrors: s.validationErrors || []
    }
}

// "All namespaces" never includes Velero itself, nor the S3 storage the
// backups are written to when it runs in this cluster: copying the storage's
// own volume into itself grows without end (and fills the disk).
function excludeArg(exclude = []) {
    const list = [...new Set(['velero', ...exclude])].filter(n => NS_RE.test(n))
    return ` --exclude-namespaces ${list.join(',')}`
}

class VolumeBackupService {
    master(cluster) {
        const m = cluster.masterNodes?.[0]
        if (!m) throw new Error('No master node found for this cluster')
        return m
    }

    async _ssh(cluster, fn) {
        const ssh = await automationEngine.connectSSH(this.master(cluster))
        try { return await fn(ssh) } finally { ssh.dispose?.() }
    }

    /** Installed?, storage reachable?, backups, restores, schedule — one round-trip. */
    status(cluster) {
        return this._ssh(cluster, async (ssh) => {
            const r = await run(ssh, [
                `echo "@@DEPLOY $(${KB} -n velero get deploy velero -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' 2>/dev/null)"`,
                `echo "@@AGENT $(${KB} -n velero get ds node-agent -o jsonpath='{.status.numberReady}/{.status.desiredNumberScheduled}' 2>/dev/null)"`,
                `echo "@@BSL"; ${KB} -n velero get backupstoragelocations -o json 2>/dev/null; echo`,
                `echo "@@BACKUPS"; ${KB} -n velero get backups.velero.io -o json 2>/dev/null; echo`,
                `echo "@@RESTORES"; ${KB} -n velero get restores.velero.io -o json 2>/dev/null; echo`,
                `echo "@@SCHEDULES"; ${KB} -n velero get schedules.velero.io -o json 2>/dev/null; echo`,
                `echo "@@NS"; ${KB} get ns -o jsonpath='{range .items[*]}{.metadata.name}{"\\n"}{end}' 2>/dev/null`
            ].join('; '))
            const sect = (name) => {
                const m = r.out.split(`@@${name}`)[1] || ''
                return m.split(/\n@@[A-Z]+/)[0].trim()
            }
            const deploy = (r.out.match(/@@DEPLOY ([^\n]*)/)?.[1] || '').trim()
            const agent = (r.out.match(/@@AGENT ([^\n]*)/)?.[1] || '').trim()
            const installed = !!deploy && deploy !== '/'
            const bsl = items(sect('BSL')).find(b => b.metadata?.name === 'default') || items(sect('BSL'))[0]
            const schedule = items(sect('SCHEDULES')).find(s => s.metadata?.name === SCHEDULE_NAME)
            return {
                installed,
                ready: installed && /^(\d+)\/\1$/.test(deploy) && deploy !== '0/0',
                nodeAgent: agent || null,
                storage: bsl ? { phase: bsl.status?.phase || 'Unknown', message: bsl.status?.message || null, lastChecked: bsl.status?.lastValidationTime || null } : null,
                backups: items(sect('BACKUPS')).map(summarizeBackup).sort((a, b) => String(b.started).localeCompare(String(a.started))),
                restores: items(sect('RESTORES')).map(summarizeRestore).sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, 20),
                schedule: schedule ? {
                    cron: schedule.spec?.schedule,
                    ttl: schedule.spec?.template?.ttl || null,
                    paused: !!schedule.spec?.paused,
                    lastBackup: schedule.status?.lastBackup || null
                } : null,
                namespaces: sect('NS').split('\n').map(s => s.trim()).filter(Boolean)
            }
        })
    }

    /** Back up namespaces (all when empty) incl. the files in their volumes. */
    backupNow(cluster, { namespaces = [], ttlDays = 30, exclude = [] } = {}) {
        if (!Array.isArray(namespaces) || namespaces.some(n => !NS_RE.test(n))) throw bad('Invalid namespace list')
        const ttl = Math.max(1, Math.min(365, parseInt(ttlDays, 10) || 30))
        const name = `kubeez-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
        return this._ssh(cluster, async (ssh) => {
            const ns = namespaces.length ? ` --include-namespaces ${namespaces.join(',')}` : excludeArg(exclude)
            const r = await run(ssh, `${VEL} backup create ${name}${ns} --ttl ${ttl * 24}h0m0s --wait=false 2>&1`)
            if (!r.ok) throw new Error(`Velero did not accept the backup: ${r.out || r.err}`)
            return { name }
        })
    }

    /**
     * Restore a backup.
     *   missing (default) → only what does not exist any more (Velero never overwrites)
     *   copy              → into new namespaces "<ns>-restored-<time>" (side by side)
     *   replace           → delete the chosen namespaces first, then restore them
     */
    restore(cluster, backup, { namespaces = [], mode = 'missing' } = {}) {
        if (!NAME_RE.test(backup || '')) throw bad('Invalid backup name')
        if (!Array.isArray(namespaces) || namespaces.some(n => !NS_RE.test(n))) throw bad('Invalid namespace list')
        if (!['missing', 'copy', 'replace'].includes(mode)) throw bad('Invalid restore mode')
        if (mode !== 'missing' && !namespaces.length) throw bad('Choose the namespaces to copy or replace.')
        if (mode === 'replace' && namespaces.some(n => /^(kube-|velero$|default$)/.test(n))) throw bad('System namespaces (kube-*, default, velero) cannot be replaced.')
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 14)
        const name = `${backup.slice(0, 40)}-r${stamp}${Math.random().toString(36).slice(2, 5)}`
        return this._ssh(cluster, async (ssh) => {
            if (mode === 'replace') {
                const d = await run(ssh, `${KB} delete ns ${namespaces.join(' ')} --ignore-not-found --wait=true --timeout=300s 2>&1`)
                if (!d.ok) throw new Error(`Could not delete the namespaces before restoring: ${d.out || d.err}`)
            }
            let args = `--from-backup ${backup}`
            if (namespaces.length) args += ` --include-namespaces ${namespaces.join(',')}`
            const mappings = mode === 'copy' ? namespaces.map(n => `${n}:${`${n}-restored-${stamp}`.slice(0, 63)}`) : []
            if (mappings.length) args += ` --namespace-mappings ${mappings.join(',')}`
            const r = await run(ssh, `${VEL} restore create ${name} ${args} --wait=false 2>&1`)
            if (!r.ok) throw new Error(`Velero did not accept the restore: ${r.out || r.err}`)
            return { name, mappings }
        })
    }

    deleteBackup(cluster, backup) {
        if (!NAME_RE.test(backup || '')) throw bad('Invalid backup name')
        return this._ssh(cluster, async (ssh) => {
            const r = await run(ssh, `${VEL} backup delete ${backup} --confirm 2>&1`)
            if (!r.ok) throw new Error(r.out || r.err)
            return { deleting: backup }
        })
    }

    /** Daily (or custom cron) backup of everything; enabled=false removes it. */
    setSchedule(cluster, { enabled, cron = '0 2 * * *', ttlDays = 30, exclude = [] } = {}) {
        if (enabled && !CRON_RE.test(String(cron).trim())) throw bad('Invalid schedule (cron with 5 fields, e.g. "0 2 * * *")')
        const ttl = Math.max(1, Math.min(365, parseInt(ttlDays, 10) || 30))
        return this._ssh(cluster, async (ssh) => {
            await run(ssh, `${VEL} schedule delete ${SCHEDULE_NAME} --confirm 2>&1`)
            if (!enabled) return { enabled: false }
            const r = await run(ssh, `${VEL} schedule create ${SCHEDULE_NAME} --schedule "${String(cron).trim()}" --ttl ${ttl * 24}h0m0s${excludeArg(exclude)} 2>&1`)
            if (!r.ok) throw new Error(`Velero did not accept the schedule: ${r.out || r.err}`)
            return { enabled: true, cron: String(cron).trim(), ttlDays: ttl }
        })
    }

    /** Velero's own description of a backup or restore (errors, warnings, volumes). */
    describe(cluster, kind, name) {
        if (!['backup', 'restore'].includes(kind) || !NAME_RE.test(name || '')) throw bad('Invalid name')
        return this._ssh(cluster, async (ssh) => {
            const r = await run(ssh, `${VEL} ${kind} describe ${name} --details 2>&1 | head -200`)
            return { text: r.out || r.err }
        })
    }
}

export const volumeBackupService = new VolumeBackupService()
