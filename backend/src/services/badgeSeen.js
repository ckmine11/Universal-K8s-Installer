import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// What each person has already seen behind a sidebar badge, per cluster: the
// critical CVE ids on Security, the certificate problems on Certificates. A
// badge counts only what is not in here — opening the tab clears it; something
// new brings it back. Per user, so a teammate's visit does not clear yours.
const FILE = path.join(DATA_DIR, 'badge-seen.json')
const MAX_KEYS = 2000   // per user, cluster and kind

let data = null
const read = () => {
    if (data) return data
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { data = {} }
    return data
}

export const badgeSeen = {
    /** Set of keys this user has seen for kind on cluster. */
    get(userId, clusterId, kind) {
        return new Set(read()[userId]?.[clusterId]?.[kind] || [])
    },
    /** Replace with what is there now: problems gone are forgotten, so they count again if they return. */
    mark(userId, clusterId, kind, keys) {
        const d = read()
        d[userId] ||= {}
        d[userId][clusterId] ||= {}
        d[userId][clusterId][kind] = [...new Set(keys)].slice(0, MAX_KEYS)
        writeFileAtomicSync(FILE, JSON.stringify(d))
    },
    _reset() { data = {} },
}
