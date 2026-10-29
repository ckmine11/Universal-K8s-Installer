import fs from 'fs'
import path from 'path'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// Deploy tokens for CI (GitHub Actions, GitLab CI, Jenkins…): each one may do
// exactly one thing — deploy one Helm release (cluster + namespace + release,
// from one repository and chart), changing only the values it lists (e.g.
// image.tag). Shown once, kept as a SHA-256 hash, with an expiry; revocable.
const FILE = path.join(DATA_DIR, 'api-tokens.json')
const PREFIX = 'kzt_'
const KEY = /^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,5}$/
const RELEASE = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const CHART = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/i
const bad = (m, status = 400) => { throw Object.assign(new Error(m), { status }) }
const hash = (t) => createHash('sha256').update(String(t)).digest('hex')

class ApiTokens {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return [] } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }
    _view(t) { const { hash: _, ...rest } = t; return { ...rest, expired: Date.parse(t.expiresAt) <= Date.now() } }

    list(orgId) { return this._read().filter(t => t.orgId === orgId).map(t => this._view(t)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }

    /** → { token (shown once), record } */
    create(orgId, input, { by, clusterIds = [], repoIds = [] } = {}) {
        const name = String(input?.name || '').trim()
        if (name.length < 3 || name.length > 60 || !/^[\w .:/-]+$/.test(name)) bad('Name: 3–60 letters, digits, spaces and . : / -')
        if (!clusterIds.includes(input?.clusterId)) bad('Pick a cluster of this workspace')
        if (!NAMESPACE.test(String(input?.namespace || ''))) bad('Namespace is not valid')
        if (!RELEASE.test(String(input?.release || ''))) bad('Release name is not valid')
        if (!repoIds.includes(input?.repoId)) bad('Pick one of the workspace\'s chart repositories')
        if (!CHART.test(String(input?.chart || ''))) bad('Chart name is not valid')
        const keys = [...new Set((Array.isArray(input?.allowedKeys) && input.allowedKeys.length ? input.allowedKeys : ['image.tag']).map(String))]
        if (keys.length > 10 || keys.some(k => !KEY.test(k) || k.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p)))) bad('Values it may change: up to 10 keys like image.tag')
        const days = Number(input?.expiresDays ?? 90)
        if (!Number.isInteger(days) || days < 1 || days > 365) bad('Expiry: 1 to 365 days')
        const all = this._read()
        if (all.filter(t => t.orgId === orgId && !t.revokedAt).length >= 100) bad('Up to 100 tokens per workspace')
        const token = `${PREFIX}${randomBytes(32).toString('base64url')}`
        const rec = {
            id: randomBytes(6).toString('hex'), orgId, name, hash: hash(token), hint: `${token.slice(0, 8)}…${token.slice(-4)}`,
            clusterId: input.clusterId, namespace: input.namespace, release: input.release, repoId: input.repoId, chart: input.chart,
            version: input.version ? String(input.version).slice(0, 60) : null, allowedKeys: keys,
            createdAt: new Date().toISOString(), createdBy: by || null, expiresAt: new Date(Date.now() + days * 86400e3).toISOString(), lastUsedAt: null, revokedAt: null
        }
        all.push(rec); this._write(all)
        return { token, record: this._view(rec) }
    }
    revoke(orgId, id, by) {
        const all = this._read(); const t = all.find(x => x.id === id && x.orgId === orgId)
        if (!t) return false
        t.revokedAt ||= new Date().toISOString(); t.revokedBy ||= by || null
        this._write(all); return true
    }
    /** The live token for a bearer string, or null (unknown, revoked, expired). */
    verify(bearer) {
        const s = String(bearer || '')
        if (!s.startsWith(PREFIX) || s.length > 100) return null
        const h = Buffer.from(hash(s))
        const all = this._read()
        const t = all.find(x => { const b = Buffer.from(x.hash); return b.length === h.length && timingSafeEqual(b, h) })
        if (!t || t.revokedAt || Date.parse(t.expiresAt) <= Date.now()) return null
        t.lastUsedAt = new Date().toISOString(); this._write(all)
        return this._view(t)
    }
}
export const apiTokens = new ApiTokens()

/**
 * The values a hook may change: { "image.tag": "1.4.2" } → checked against the
 * token's keys (strings, numbers, booleans only) and set into a copy of `values`.
 */
export function applySet(values, set, allowedKeys) {
    if (set == null) return values
    if (typeof set !== 'object' || Array.isArray(set)) bad('set: an object like {"image.tag": "1.4.2"}')
    const out = structuredClone(values || {})
    for (const [k, v] of Object.entries(set)) {
        if (!allowedKeys.includes(k)) bad(`This token may not change ${k} (it may change: ${allowedKeys.join(', ')})`, 403)
        if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 200) bad(`${k}: a short string, number or true/false`)
        const parts = k.split('.')
        let o = out
        for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object' || Array.isArray(o[p])) o[p] = {}; o = o[p] }
        o[parts.at(-1)] = v
    }
    return out
}
