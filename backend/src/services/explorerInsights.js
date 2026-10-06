import { explorerApi, basePath } from './explorerProxy.js'

// KubeEZ's own screens built from the Cluster Explorer's (Radar's) analysis:
// the upgrade safety check and the cluster health score.

const minorOf = (v) => String(v || '').replace(/^v/, '').split('.').slice(0, 2).join('.')

/** Radar's upgrade-readiness report → what the upgrade dialog needs. */
export function summarizeReadiness(r, clusterId) {
    const findings = (r.checks || []).flatMap(c => (c.findings || []).map(f => ({
        check: c.title,
        level: f.level,
        title: f.title,
        impact: f.impact,
        remediation: f.remediation,
        resource: f.resource ? { kind: f.resource.kind, namespace: f.resource.namespace || null, name: f.resource.name } : null
    })))
    const pick = (level) => findings.filter(f => f.level === level)
    return {
        installed: true,
        verdict: r.verdict,                     // blocked | warning | review | no_known_blockers | unknown
        currentVersion: r.currentVersion,
        targetVersion: r.targetVersion,
        reviewedThrough: r.reviewedThrough,
        summary: r.summary || {},
        blockers: pick('blocker').slice(0, 25),
        warnings: pick('warning').slice(0, 25),
        reviews: pick('review').length,
        openChecks: (r.checks || []).filter(c => !['passed', 'not_applicable'].includes(c.status))
            .map(c => ({ id: c.id, title: c.title, status: c.status, summary: c.summary })).slice(0, 30),
        observedAt: r.observedAt || null,
        detailsUrl: `${basePath(clusterId)}/checks/upgrade`
    }
}

/** Radar's audit → a 0–100 health score + the checks to fix first. */
export function summarizeAudit(a, clusterId) {
    const s = a?.summary || {}
    const passing = s.passing || 0, warning = s.warning || 0, danger = s.danger || 0
    const total = passing + warning + danger
    const score = total ? Math.round(100 * (passing + 0.4 * warning) / total) : 100
    const sev = { danger: 0, warning: 1 }
    const top = (a?.groupedChecks || [])
        .filter(c => c.effectiveSeverity === 'danger' || c.effectiveSeverity === 'warning')
        .sort((x, y) => (sev[x.effectiveSeverity] - sev[y.effectiveSeverity]) || ((y.affectedResources || 0) - (x.affectedResources || 0)))
        .slice(0, 6)
        .map(c => ({ title: c.title, category: c.category, severity: c.effectiveSeverity, resources: c.affectedResources || 0, message: c.message }))
    return {
        installed: true,
        score,
        passing, warning, danger,
        categories: Object.fromEntries(Object.entries(s.categories || {}).map(([k, v]) => [k, { passing: v.passing || 0, warning: v.warning || 0, danger: v.danger || 0 }])),
        top,
        detailsUrl: `${basePath(clusterId)}/checks`
    }
}

export async function upgradeReadiness(cluster, user, targetVersion) {
    const minor = minorOf(targetVersion)
    if (!/^\d{1,2}\.\d{1,3}$/.test(minor)) throw Object.assign(new Error('Invalid target version'), { status: 400 })
    const r = await explorerApi(cluster, user, `/api/upgrade-readiness?target=${minor}`, { timeoutMs: 90000 })
    return summarizeReadiness(r, cluster.id)
}

export async function clusterHealth(cluster, user) {
    const a = await explorerApi(cluster, user, '/api/audit', { timeoutMs: 60000 })
    return summarizeAudit(a, cluster.id)
}
