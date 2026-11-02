import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import { DATA_DIR } from '../utils/paths.js'

// The plan a self-hosted server's license gives every workspace on it.
// A license is instance-wide: while one is active (valid signature, not
// expired, bound to this server's System ID if it names one), each workspace
// gets its plan for features, alerts, backups, compliance, roles — and seats.
// No license, an expired or invalid one, or the hosted edition → null (the
// workspace owner's own subscription decides, as before).
//   ENTERPRISE (or a name containing it) → ENTERPRISE; any other paid license
//   (PRO, EVALUATION, TRIAL…) → PRO. Seats: the license's maxMembers, or no limit.
// Read synchronously (every plan check calls it) and cached for a minute.
const FILES = { license: 'license.json', key: 'public.pem', system: 'system.json' }
const TTL = 60e3
let cache = null   // { at, stamp, value }

const read = (f) => fs.readFileSync(path.join(DATA_DIR, f), 'utf8')
const stamp = () => Object.values(FILES).map(f => { try { return fs.statSync(path.join(DATA_DIR, f)).mtimeMs } catch { return 0 } }).join('|')

export function planOfLicense(name) {
    const n = String(name || '').toUpperCase()
    return n.includes('ENTERPRISE') ? 'ENTERPRISE' : 'PRO'
}

function evaluate() {
    let saved, key
    try { saved = JSON.parse(read(FILES.license)); key = read(FILES.key) } catch { return null }
    if (!saved?.licenseKey) return null
    let d
    try { d = jwt.verify(saved.licenseKey, key, { algorithms: ['RS256'] }) } catch { return null }   // bad signature or expired
    if (d.systemId) {
        let systemId = null
        try { systemId = JSON.parse(read(FILES.system)).systemId } catch { }
        if (d.systemId !== systemId) return null
    }
    const seats = Number(d.maxMembers)
    return { plan: planOfLicense(d.plan), name: String(d.plan || ''), maxMembers: Number.isInteger(seats) && seats > 0 ? seats : null, expiresAt: new Date(d.exp * 1000).toISOString() }
}

/** The active license's plan → { plan: 'PRO' | 'ENTERPRISE', name, maxMembers (null = no limit), expiresAt } or null. */
export function licensedPlan(now = Date.now()) {
    if (process.env.KUBEEZ_MODE === 'saas') return null
    const s = stamp()
    if (!cache || cache.stamp !== s || now - cache.at > TTL) cache = { at: now, stamp: s, value: evaluate() }
    // an expiry inside the cache minute still counts
    return cache.value && Date.parse(cache.value.expiresAt) > now ? cache.value : null
}
export const forgetLicensePlan = () => { cache = null }
