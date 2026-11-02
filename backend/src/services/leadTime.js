import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// DORA lead time for changes: from the commit to the moment it runs. CI sends
// the commit with the deploy webhook ({ commit: { sha, time } }); when the
// deploy job finishes well, the change is kept here (per workspace, the newest
// MAX). Deploys without a commit simply do not count.
const FILE = path.join(DATA_DIR, 'lead-times.json')
const MAX = 2000
const SHA = /^[0-9a-f]{7,64}$/i
const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }) }

/** { sha, time } from the webhook body → { sha, commitAt } or null (none sent). */
export function cleanCommit(c, now = Date.now()) {
    if (c == null) return null
    if (typeof c !== 'object') bad('commit: { "sha": "…", "time": "ISO date of the commit" }')
    const sha = String(c.sha || '').trim()
    if (!SHA.test(sha)) bad('commit.sha must be a Git commit hash')
    const t = Date.parse(String(c.time || ''))
    if (Number.isNaN(t)) bad('commit.time must be a date, e.g. git log -1 --format=%cI')
    if (t > now + 5 * 60e3) bad('commit.time is in the future')
    if (t < now - 365 * 86400e3) bad('commit.time is more than a year ago')
    return { sha: sha.toLowerCase(), commitAt: new Date(t).toISOString() }
}

class LeadTimeStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    record(orgId, { clusterId, namespace, release, sha, commitAt, deployedAt = new Date().toISOString(), by = null }) {
        const all = this._read()
        const list = all[orgId || '_'] ||= []
        list.push({ clusterId, namespace, release, sha, commitAt, deployedAt, by })
        if (list.length > MAX) list.splice(0, list.length - MAX)
        fs.mkdirSync(DATA_DIR, { recursive: true })
        writeFileAtomicSync(FILE, JSON.stringify(all, null, 2))
    }
    forCluster(orgId, clusterId) { return (this._read()[orgId || '_'] || []).filter(c => c.clusterId === clusterId) }
}
export const leadTimes = new LeadTimeStore()
