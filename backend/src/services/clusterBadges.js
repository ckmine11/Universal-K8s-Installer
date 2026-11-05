import { readSecurity, lastSecurity, summarizeSecurity } from './security.js'
import { readCerts, lastCerts, limitCerts } from './certManager.js'

// Sidebar badges of one cluster: critical CVEs on Security, certificates that
// need attention on Certificates. Built only from the last read of each report
// (the tab, the 6-hourly certificate check), so polling them never loads the
// cluster; a read older than STALE is refreshed in the background, once at a time.
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

/** Critical vulnerabilities (distinct CVEs) the member may see; null when never read or Trivy is missing. */
export function securityBadge(value, match) {
    if (!value) return null
    const s = summarizeSecurity(value, { match, maxCves: Infinity })
    const critical = s.cves.filter(c => c.severity === 'CRITICAL').length
    return { count: critical, tone: 'red', title: `${critical} critical vulnerabilit${critical === 1 ? 'y' : 'ies'}` }
}

/** Certificates expired, failing or expiring soon; red when any is expired or failing. */
export function certificatesBadge(value, match) {
    if (!value || value.tool?.state !== 'ok') return null
    const certs = limitCerts(value, match).certificates
    const broken = certs.filter(c => c.state === 'expired' || c.state === 'failing').length
    const expiring = certs.filter(c => c.state === 'expiring').length
    const parts = [broken && `${broken} expired or failing`, expiring && `${expiring} expiring soon`].filter(Boolean)
    return { count: broken + expiring, tone: broken ? 'red' : 'amber', title: parts.join(', ') || 'All certificates are fine' }
}

/**
 * cluster: the stored cluster. allowed(kind): the member may see that section and
 * its feature is on. match: the member's namespace filter (null = all).
 */
export function clusterBadges(cluster, { allowed, match = null, now = Date.now(), refresh = true } = {}) {
    const out = {}
    const usable = refresh && !(cluster.status === 'failed' && cluster.mode === 'install')
    if (allowed('security')) {
        out.security = securityBadge(lastSecurity(cluster.id)?.value, match)
        if (usable) refreshIfStale('security', cluster, now)
    }
    if (allowed('certificates')) {
        out.certificates = certificatesBadge(lastCerts(cluster.id)?.value, match)
        if (usable) refreshIfStale('certificates', cluster, now)
    }
    return out
}
