import { readSecurity, lastSecurity, summarizeSecurity } from './security.js'
import { readCerts, lastCerts, limitCerts } from './certManager.js'

// Sidebar badges of one cluster: critical CVEs on Security, certificates that
// need attention on Certificates — counting only what the person has not seen
// yet. Built only from the last read of each report (the tab, the 6-hourly
// certificate check), so polling them never loads the cluster; a read older than
// STALE is refreshed in the background, once at a time.
export const STALE = 15 * 60e3

const SOURCES = {
    security: { last: lastSecurity, read: (c) => readSecurity(c, { fresh: true }) },
    certificates: { last: lastCerts, read: (c) => readCerts(c, { fresh: true }) },
}

const running = new Set()   // "kind|clusterId" being refreshed
function refreshIfStale(kind, cluster, now) {
    const hit = SOURCES[kind].last(cluster.id)
    if (hit && now - hit.at < STALE) return
    const key = `${kind}|${cluster.id}`
    if (running.has(key)) return
    running.add(key)
    SOURCES[kind].read(cluster).catch(() => { }).finally(() => running.delete(key))
}

// What a badge is about: the problems now, each with a key; the badge counts
// the ones this person has not seen yet (services/badgeSeen.js).
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
function badge(problems, seen, { tone, words }) {
    const fresh = problems.filter(p => !seen.has(p.key))
    const total = problems.length
    const title = !total ? words.none
        : fresh.length === total ? words.all(total)
            : fresh.length ? `${words.fresh(fresh.length)} (${total} in all)` : `${words.all(total)} — seen`
    return { count: fresh.length, total, tone: tone(fresh.length ? fresh : problems), title }
}

/** Critical vulnerabilities (distinct CVEs) the member may see — key: the CVE id. */
export function securityProblems(value, match) {
    if (!value) return null
    return summarizeSecurity(value, { match, maxCves: Infinity }).cves.filter(c => c.severity === 'CRITICAL').map(c => ({ key: c.id }))
}
/** Certificates expired, failing or expiring soon — key: namespace/name:state, so getting worse counts again. */
export function certificateProblems(value, match) {
    if (!value || value.tool?.state !== 'ok') return null
    return limitCerts(value, match).certificates.filter(c => ['expired', 'failing', 'expiring'].includes(c.state)).map(c => ({ key: `${c.namespace}/${c.name}:${c.state}`, state: c.state }))
}

/** null when never read (or Trivy is missing); count = critical CVEs not seen yet. */
export function securityBadge(value, match, seen = new Set()) {
    const p = securityProblems(value, match)
    return p && badge(p, seen, {
        tone: () => 'red',
        words: { none: 'No critical vulnerabilities', all: (n) => plural(n, 'critical vulnerability', 'critical vulnerabilities'), fresh: (n) => plural(n, 'new critical vulnerability', 'new critical vulnerabilities') },
    })
}

/** count = certificate problems not seen yet; red when one of them is expired or failing. */
export function certificatesBadge(value, match, seen = new Set()) {
    const p = certificateProblems(value, match)
    return p && badge(p, seen, {
        tone: (list) => list.some(c => c.state !== 'expiring') ? 'red' : 'amber',
        words: { none: 'All certificates are fine', all: (n) => plural(n, 'certificate needs', 'certificates need') + ' attention', fresh: (n) => plural(n, 'certificate newly needs', 'certificates newly need') + ' attention' },
    })
}

/** The problems a badge is about right now — what "seen" records. */
export function currentProblemKeys(cluster, kind, match = null) {
    const p = kind === 'security' ? securityProblems(lastSecurity(cluster.id)?.value, match)
        : kind === 'certificates' ? certificateProblems(lastCerts(cluster.id)?.value, match) : null
    return p ? p.map(x => x.key) : null
}

/**
 * cluster: the stored cluster. allowed(kind): the member may see that section and
 * its feature is on. match: the member's namespace filter (null = all).
 * seen(kind): what this person has seen (a Set).
 */
export function clusterBadges(cluster, { allowed, match = null, seen = () => new Set(), now = Date.now(), refresh = true } = {}) {
    const out = {}
    const usable = refresh && !(cluster.status === 'failed' && cluster.mode === 'install')
    if (allowed('security')) {
        out.security = securityBadge(lastSecurity(cluster.id)?.value, match, seen('security'))
        if (usable) refreshIfStale('security', cluster, now)
    }
    if (allowed('certificates')) {
        out.certificates = certificatesBadge(lastCerts(cluster.id)?.value, match, seen('certificates'))
        if (usable) refreshIfStale('certificates', cluster, now)
    }
    return out
}
