import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { auditLog, AUDIT_RETENTION_DAYS } from './auditLog.js'

// Terminal access, just in time: nobody has a standing shell on the nodes.
// Each terminal session needs a grant for one cluster — a reason and a time
// limit. Admins grant themselves (recorded); operators need an admin's
// approval when the workspace asks for it. Every session is recorded:
// commands and output, kept like the audit trail.

const FILE = path.join(DATA_DIR, 'terminal-access.json')
const REC_DIR = path.join(DATA_DIR, 'terminal-sessions')
export const GRANT_MINUTES = [15, 30, 60, 120]
const PENDING_TTL_MS = 2 * 3600e3          // an unanswered request lapses after 2 hours
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024   // per recorded session
const isAdmin = (u) => u.role === 'admin' || u.role === 'superadmin'

class TerminalAccess {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { settings: {}, grants: [] } } }
    _write(d) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(d, null, 1)) }
    _tidy(d, now = Date.now()) {
        for (const g of d.grants) {
            if (g.status === 'active' && Date.parse(g.expiresAt) <= now) g.status = 'expired'
            if (g.status === 'pending' && now - Date.parse(g.requestedAt) > PENDING_TTL_MS) g.status = 'lapsed'
        }
        // keep a year of decisions (they are in the audit trail too)
        d.grants = d.grants.filter(g => now - Date.parse(g.requestedAt) < 365 * 86400e3).slice(-2000)
        return d
    }

    settings(orgId) { return { requireApproval: true, ...(this._read().settings[orgId || '_'] || {}) } }
    setSettings(orgId, s, by) {
        const d = this._read()
        d.settings[orgId || '_'] = { requireApproval: s.requireApproval !== false }
        this._write(d)
        auditLog.record({ orgId, actor: by, action: 'terminal.settings', detail: `operators need approval: ${d.settings[orgId || '_'].requireApproval ? 'yes' : 'no'}` })
        return d.settings[orgId || '_']
    }

    list(filter = () => true) { const d = this._tidy(this._read()); this._write(d); return d.grants.filter(filter).reverse() }

    /** The grant that lets this user open a terminal on this cluster now, if any */
    activeGrant(userId, clusterId, now = Date.now()) {
        return this._read().grants.find(g => g.userId === userId && g.clusterId === clusterId && g.status === 'active' && Date.parse(g.expiresAt) > now) || null
    }

    /** Does this user get access at once (admins; everyone when the workspace needs no approval)? */
    immediate(user, orgId) { return isAdmin(user) || !this.settings(orgId).requireApproval }

    request(user, cluster, { reason, minutes }) {
        const auto = this.immediate(user, cluster.orgId)
        // a reason is needed when an admin has to decide; immediate access is recorded anyway
        const why = String(reason || '').trim() || (auto ? (isAdmin(user) ? 'Admin session' : 'Terminal session') : '')
        if (why.length < 5) throw Object.assign(new Error('Say why you need the terminal (at least a few words) — an admin approves it and it is recorded.'), { status: 400 })
        const mins = minutes == null || minutes === '' ? (auto ? 60 : NaN) : Number(minutes)
        if (!GRANT_MINUTES.includes(mins)) throw Object.assign(new Error(`Choose ${GRANT_MINUTES.join(', ')} minutes`), { status: 400 })
        const d = this._tidy(this._read())
        if (d.grants.some(g => g.userId === user.id && g.clusterId === cluster.id && g.status === 'pending')) throw Object.assign(new Error('You already asked for access to this cluster — wait for an admin.'), { status: 409 })
        const now = new Date()
        const g = {
            id: randomUUID(), orgId: cluster.orgId || null, clusterId: cluster.id, clusterName: cluster.clusterName || cluster.id,
            userId: user.id, username: user.username, role: user.role, reason: why.slice(0, 300), minutes: mins,
            requestedAt: now.toISOString(), status: auto ? 'active' : 'pending',
            decidedBy: auto ? (isAdmin(user) ? `${user.username} (own admin access)` : 'no approval required') : null,
            decidedAt: auto ? now.toISOString() : null,
            expiresAt: auto ? new Date(now.getTime() + mins * 60e3).toISOString() : null
        }
        d.grants.push(g)
        this._write(d)
        auditLog.record({ orgId: g.orgId, actor: user, action: auto ? 'terminal.access_granted' : 'terminal.access_requested', target: { clusterId: g.clusterId, clusterName: g.clusterName }, detail: `${mins} min — ${g.reason}` })
        return g
    }

    decide(id, admin, approve) {
        const d = this._tidy(this._read())
        const g = d.grants.find(x => x.id === id)
        if (!g || (admin.role !== 'superadmin' && g.orgId !== admin.orgId)) throw Object.assign(new Error('Request not found'), { status: 404 })
        if (g.status !== 'pending') throw Object.assign(new Error(`This request is already ${g.status}`), { status: 409 })
        const now = new Date()
        Object.assign(g, { status: approve ? 'active' : 'denied', decidedBy: admin.username, decidedAt: now.toISOString(), expiresAt: approve ? new Date(now.getTime() + g.minutes * 60e3).toISOString() : null })
        this._write(d)
        auditLog.record({ orgId: g.orgId, actor: admin, action: approve ? 'terminal.access_approved' : 'terminal.access_denied', target: { clusterId: g.clusterId, clusterName: g.clusterName }, detail: `${g.username}: ${g.minutes} min — ${g.reason}` })
        return g
    }

    revoke(id, by) {
        const d = this._tidy(this._read())
        const g = d.grants.find(x => x.id === id)
        if (!g || (by.role !== 'superadmin' && g.orgId !== by.orgId)) throw Object.assign(new Error('Grant not found'), { status: 404 })
        if (!(isAdmin(by) || g.userId === by.id)) throw Object.assign(new Error('Only an admin or the holder can end this access'), { status: 403 })
        if (g.status !== 'active' && g.status !== 'pending') return g
        Object.assign(g, { status: 'revoked', revokedBy: by.username, revokedAt: new Date().toISOString() })
        this._write(d)
        auditLog.record({ orgId: g.orgId, actor: by, action: 'terminal.access_revoked', target: { clusterId: g.clusterId, clusterName: g.clusterName }, detail: g.username })
        return g
    }
}
export const terminalAccess = new TerminalAccess()

// ── recordings ──────────────────────────────────────────────────────────────
const recFile = (id, at) => path.join(REC_DIR, at.slice(0, 7), `${id}.jsonl`)
class TerminalRecorder {
    constructor() { this.open = new Map() }   // sessionId → { file, bytes, meta }

    start(meta) {
        const id = randomUUID(), at = new Date().toISOString()
        const file = recFile(id, at)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const head = { t: at, type: 'start', id, ...meta }
        fs.writeFileSync(file, JSON.stringify(head) + '\n', { mode: 0o600 })
        this.open.set(id, { file, bytes: 0, meta: head, commands: 0 })
        auditLog.record({ orgId: meta.orgId, actor: meta.user, action: 'terminal.session_start', target: { clusterId: meta.clusterId, clusterName: meta.clusterName }, detail: `recording ${id}${meta.grantId ? ` · grant ${meta.grantId.slice(0, 8)}` : ''}` })
        return id
    }
    command(id, nodes, command) {
        const s = this.open.get(id); if (!s) return
        s.commands++
        fs.appendFileSync(s.file, JSON.stringify({ t: new Date().toISOString(), type: 'cmd', nodes, command }) + '\n')
        auditLog.record({ orgId: s.meta.orgId, actor: s.meta.user, action: 'terminal.command', target: { clusterId: s.meta.clusterId, clusterName: s.meta.clusterName }, detail: `[${nodes.length} node${nodes.length === 1 ? '' : 's'}] ${command.slice(0, 300)}` })
    }
    output(id, node, stream, chunk) {
        const s = this.open.get(id); if (!s) return
        if (s.bytes >= MAX_OUTPUT_BYTES) {
            if (!s.cut) { s.cut = true; fs.appendFileSync(s.file, JSON.stringify({ t: new Date().toISOString(), type: 'note', text: 'output beyond 2 MB not recorded' }) + '\n') }
            return
        }
        const text = String(chunk).slice(0, MAX_OUTPUT_BYTES - s.bytes)
        s.bytes += Buffer.byteLength(text)
        fs.appendFileSync(s.file, JSON.stringify({ t: new Date().toISOString(), type: 'out', node, stream, text }) + '\n')
        if (text.length < String(chunk).length) {
            s.cut = true; s.bytes = MAX_OUTPUT_BYTES
            fs.appendFileSync(s.file, JSON.stringify({ t: new Date().toISOString(), type: 'note', text: 'output beyond 2 MB not recorded' }) + '\n')
        }
    }
    end(id, why = 'closed') {
        const s = this.open.get(id); if (!s) return
        fs.appendFileSync(s.file, JSON.stringify({ t: new Date().toISOString(), type: 'end', why, commands: s.commands }) + '\n')
        this.open.delete(id)
        auditLog.record({ orgId: s.meta.orgId, actor: s.meta.user, action: 'terminal.session_end', target: { clusterId: s.meta.clusterId, clusterName: s.meta.clusterName }, detail: `${s.commands} command${s.commands === 1 ? '' : 's'} · ${why}` })
    }

    _read(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] } }
    _files() {
        try { return fs.readdirSync(REC_DIR).sort().reverse().flatMap(m => fs.readdirSync(path.join(REC_DIR, m)).map(f => path.join(REC_DIR, m, f))) } catch { return [] }
    }
    /** Sessions of an org (null = all), newest first: who, cluster, when, how many commands */
    list({ orgId, limit = 200 } = {}) {
        const out = []
        for (const f of this._files()) {
            const rows = this._read(f)
            const head = rows[0]
            if (!head || head.type !== 'start' || (orgId != null && head.orgId !== orgId)) continue
            const end = rows.find(r => r.type === 'end')
            out.push({ id: head.id, at: head.t, user: head.user?.username, role: head.user?.role, clusterId: head.clusterId, clusterName: head.clusterName, node: head.node || null, mode: head.mode || 'broadcast', reason: head.reason, grantId: head.grantId, ip: head.ip, endedAt: end?.t || null, commands: rows.filter(r => r.type === 'cmd').length, live: this.open.has(head.id) })
            if (out.length >= limit) break
        }
        return out.sort((a, b) => b.at.localeCompare(a.at))
    }
    get(id, orgId) {
        if (!/^[0-9a-f-]{36}$/.test(id)) return null
        const f = this._files().find(x => x.endsWith(`${id}.jsonl`))
        const rows = f ? this._read(f) : []
        if (!rows.length || (orgId != null && rows[0].orgId !== orgId)) return null
        return rows
    }
    prune(now = Date.now()) {
        const cutoff = new Date(now - AUDIT_RETENTION_DAYS * 86400e3).toISOString().slice(0, 7)
        try { for (const m of fs.readdirSync(REC_DIR)) if (m < cutoff) fs.rmSync(path.join(REC_DIR, m), { recursive: true, force: true }) } catch { }
    }
}
export const terminalRecorder = new TerminalRecorder()

/** Tell the admins (alert channels) that an operator waits for terminal access */
export async function announceRequest(g) {
    if (g.status !== 'pending' || !g.orgId) return
    const { notifier } = await import('./notifier.js')
    notifier.emit(g.orgId, {
        type: 'access_request', severity: 'warning', key: `access|${g.id}`,
        title: `Terminal access requested: ${g.username} → ${g.clusterName}`,
        text: `${g.username} (${g.role}) asks for ${g.minutes} minutes of terminal access: "${g.reason}". Approve or deny in KubeEZ → Compliance → Access.`,
        clusterId: g.clusterId, clusterName: g.clusterName, link: '/compliance?tab=access'
    })
}
