import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// Approvals of each workspace — pure data (no access logic here, so the
// access layer can read active elevations without an import cycle).
//
//  requests: { id, orgId, kind: 'action' | 'elevation', status, requestedBy, reason, createdAt, decidedBy, decidedAt, comment, ... }
//    action    — a dangerous action that needs a second person: action, clusterId, clusterName, method, path, bodyHash, summary
//                status: pending → approved → used | denied | cancelled | expired
//    elevation — a temporary role on a cluster ('*' = every cluster): clusterId, clusterName, role, roleName, minutes, until
//                status: pending → active → ended | expired | denied | cancelled
//  settings: orgId → { actions: { 'cluster:delete': true, ... } }
const FILE = path.join(DATA_DIR, 'approvals.json')
const KEEP_DAYS = 90
const APPROVED_VALID_MS = 60 * 60 * 1000   // an approved action must run within an hour

let cache = null
function load() {
    if (cache) return cache
    try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { cache = {} }
    cache.requests ||= []; cache.settings ||= {}
    return cache
}
function save() {
    const all = load()
    const cutoff = Date.now() - KEEP_DAYS * 864e5
    all.requests = all.requests.filter(r => new Date(r.createdAt).getTime() > cutoff)
    fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2))
}

// time moves on: pending requests older than a day, approved actions not run
// within the hour and elevations past their end expire
function sweep(now = Date.now()) {
    const changed = []
    for (const r of load().requests) {
        if (r.status === 'pending' && now - new Date(r.createdAt).getTime() > 24 * 3600e3) { r.status = 'expired'; changed.push(r) }
        else if (r.kind === 'action' && r.status === 'approved' && now - new Date(r.decidedAt).getTime() > APPROVED_VALID_MS) { r.status = 'expired'; changed.push(r) }
        else if (r.kind === 'elevation' && r.status === 'active' && new Date(r.until).getTime() <= now) { r.status = 'expired'; r.endedAt = new Date(r.until).toISOString(); changed.push(r) }
    }
    if (changed.length) save()
    return changed
}

export const approvalStore = {
    sweep,
    APPROVED_VALID_MS,
    settings(orgId) { return { actions: {}, ...(load().settings[orgId || '_'] || {}) } },
    saveSettings(orgId, s) { load().settings[orgId || '_'] = s; save(); return this.settings(orgId) },

    list(orgId) { sweep(); return load().requests.filter(r => r.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) },
    get(id) { sweep(); return load().requests.find(r => r.id === id) || null },
    add(req) {
        const r = { id: randomBytes(8).toString('hex'), status: 'pending', createdAt: new Date().toISOString(), ...req }
        load().requests.push(r); save(); return r
    },
    update(id, patch) {
        const r = load().requests.find(x => x.id === id)
        if (!r) return null
        Object.assign(r, patch); save(); return r
    },

    /** Active temporary roles of a member (used by the access layer on every check). */
    activeElevations(userId, now = Date.now()) {
        return load().requests.filter(r => r.kind === 'elevation' && r.status === 'active' && r.requestedBy?.id === userId && new Date(r.until).getTime() > now)
    },
    _reset() { cache = null }
}
