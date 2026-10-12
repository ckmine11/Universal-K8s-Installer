import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DATA_DIR } from '../utils/paths.js'

// Audit trail: who did what in KubeEZ, when, from where — evidence for CERT-In
// (logs for 180 days) and the DPDP Rules (logs for one year), and for anyone
// asking "who restored this cluster?".
//
// Append-only JSON lines, one file per month (DATA_DIR/audit/2026-10.jsonl).
// Every entry carries the SHA-256 of the previous one (a hash chain): editing
// or deleting a line breaks the chain, and verify() shows where.
// Kept 400 days (AUDIT_RETENTION_DAYS) — more than a year, for DPDP.

const DIR = path.join(DATA_DIR, 'audit')
const RETENTION_DAYS = Math.max(180, Number(process.env.AUDIT_RETENTION_DAYS) || 400)
const GENESIS = '0'.repeat(64)

const monthOf = (iso) => iso.slice(0, 7)
const fileOf = (month) => path.join(DIR, `${month}.jsonl`)
const hashOf = (prev, entry) => crypto.createHash('sha256').update(prev + JSON.stringify(entry)).digest('hex')

class AuditLog {
    constructor() { this.last = null }

    _months() {
        try { return fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).map(f => f.slice(0, 7)).sort() } catch { return [] }
    }
    _read(month) {
        try {
            return fs.readFileSync(fileOf(month), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { _corrupt: l } } })
        } catch { return [] }
    }
    _lastHash() {
        if (this.last) return this.last
        const months = this._months()
        for (let i = months.length - 1; i >= 0; i--) {
            const rows = this._read(months[i])
            if (rows.length) return (this.last = rows[rows.length - 1].hash || GENESIS)
        }
        return (this.last = GENESIS)
    }

    /**
     * Add an entry. actor: { id, username, role } (or null = KubeEZ itself).
     * action: short dotted name ("cluster.upgrade", "auth.login_failed", "POST /api/clusters/:id/addons").
     */
    record({ orgId = null, actor = null, ip = null, action, target = null, ok = true, status = null, detail = null }) {
        try {
            fs.mkdirSync(DIR, { recursive: true })
            const at = new Date().toISOString()
            const prev = this._lastHash()
            const entry = {
                at, orgId, actor: actor ? { id: actor.id || null, username: actor.username || null, role: actor.role || null } : null,
                ip, action: String(action).slice(0, 200), target, ok: !!ok, status, detail: detail == null ? null : String(detail).slice(0, 500), prev
            }
            const hash = hashOf(prev, entry)
            fs.appendFileSync(fileOf(monthOf(at)), JSON.stringify({ ...entry, hash }) + '\n')
            this.last = hash
            return { ...entry, hash }
        } catch (e) {
            console.warn('[Audit] could not record:', e.message)
            return null
        }
    }

    /** Entries of an org (null = all, for superadmins), newest first */
    query({ orgId, from, to, clusterId, actor, action, limit = 500 } = {}) {
        const fromIso = from ? new Date(from).toISOString() : '0000'
        const toIso = to ? new Date(to).toISOString() : '9999'
        const out = []
        const months = this._months().filter(m => m >= fromIso.slice(0, 7) && m <= toIso.slice(0, 7)).reverse()
        for (const m of months) {
            const rows = this._read(m)
            for (let i = rows.length - 1; i >= 0; i--) {
                const r = rows[i]
                if (r._corrupt || r.at < fromIso || r.at > toIso) continue
                if (orgId !== undefined && orgId !== null && r.orgId !== orgId) continue
                if (clusterId && r.target?.clusterId !== clusterId) continue
                if (actor && r.actor?.username !== actor) continue
                if (action && !String(r.action).includes(action)) continue
                out.push(r)
                if (out.length >= limit) return out
            }
        }
        return out
    }

    /**
     * Check the hash chain over everything kept. A broken link means a line
     * was changed, removed or inserted. (Files deleted by retention start a
     * new valid chain at the oldest kept entry.)
     */
    verify() {
        let prev = null, count = 0
        for (const m of this._months()) {
            for (const r of this._read(m)) {
                if (r._corrupt) return { ok: false, count, brokenAt: m, reason: 'an unreadable line' }
                const { hash, ...entry } = r
                if (prev !== null && entry.prev !== prev) return { ok: false, count, brokenAt: r.at, reason: 'an entry is missing or was inserted' }
                if (hashOf(entry.prev, entry) !== hash) return { ok: false, count, brokenAt: r.at, reason: 'an entry was changed' }
                prev = hash; count++
            }
        }
        return { ok: true, count }
    }

    /** Oldest entry kept and the configured retention (the evidence for "logs kept N days") */
    coverage(orgId) {
        const months = this._months()
        let oldest = null
        for (const m of months) {
            const r = this._read(m).find(x => !x._corrupt && (orgId == null || x.orgId === orgId))
            if (r) { oldest = r.at; break }
        }
        return { retentionDays: RETENTION_DAYS, oldest, files: months.length }
    }

    /** Remove months older than the retention */
    prune(now = Date.now()) {
        const cutoff = new Date(now - RETENTION_DAYS * 86400e3).toISOString().slice(0, 7)
        let removed = 0
        for (const m of this._months()) if (m < cutoff) { try { fs.unlinkSync(fileOf(m)); removed++ } catch { } }
        return removed
    }

    start() {
        if (this.timer) return
        this.prune()
        this.timer = setInterval(() => this.prune(), 24 * 3600e3)
        this.timer.unref?.()
    }
}

export const auditLog = new AuditLog()
export const AUDIT_RETENTION_DAYS = RETENTION_DAYS

// what an API call is, for the trail: "POST /api/clusters/:id/addons"
const routeName = (req) => `${req.method} ${(req.baseUrl || '') + (req.route?.path || req.path || '')}`.replace(/\/+$/, '')
const SKIP = [/^\/api\/agent\//, /^\/api\/auth\/(login|logout)/, /^\/api\/stripe/, /\/preview$/, /^\/api\/health/]

/** Express middleware: every change made through the API (POST/PUT/PATCH/DELETE) by a signed-in user */
export function auditTrail(req, res, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || SKIP.some(r => r.test(req.originalUrl))) return next()
    res.on('finish', () => {
        if (!req.user) return
        const m = /^\/api\/clusters\/([^/?]+)/.exec(req.originalUrl)
        auditLog.record({
            orgId: req.user.orgId || null, actor: req.user, ip: req.ip || null,
            action: routeName(req),
            target: m && m[1] !== 'install' ? { clusterId: decodeURIComponent(m[1]) } : null,
            ok: res.statusCode < 400, status: res.statusCode
        })
    })
    next()
}
