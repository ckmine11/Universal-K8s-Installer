// Fleet — every cluster of the workspace on one page: risk and problems side
// by side, version drift (Kubernetes and add-ons), and the same problem on
// several clusters (usually one bad image or setting rolled out everywhere).
// Facts only; AI can summarise.
import { label as reasonLabel } from '../../config/incidentCatalog.js'
import { LATEST_K8S_MINOR } from '../complianceScanner.js'

const minor = (v) => Number((String(v || '').match(/^v?\d+\.(\d+)/) || [])[1]) || null
// a pod's workload name without the ReplicaSet / pod hashes (web-7d9f8-x2k → web)
export const workloadName = (inc) => {
    const own = String(inc.owner || '')
    if (/^(deployment|statefulset|daemonset)\//i.test(inc.target || '')) return inc.target.split('/')[1]
    if (own.startsWith('ReplicaSet/')) return own.slice(11).replace(/-[a-z0-9]{6,10}$/, '')
    if (/^(StatefulSet|DaemonSet|Job)\//.test(own)) return own.split('/')[1]
    return null
}

/**
 * clusters: [{ id, clusterName, k8sVersion, addons }], incidents: open ones of the workspace,
 * risks: { clusterId: { score, level, top } }, addonVersion(clusterId, key) → version | null
 */
export function fleetView({ clusters, incidents, risks, addonVersion = () => null }) {
    const rows = clusters.map(c => {
        const open = incidents.filter(i => i.clusterId === c.id)
        return {
            id: c.id, name: c.clusterName, k8sVersion: c.k8sVersion, risk: risks[c.id] || null,
            open: open.length, critical: open.filter(i => i.severity === 'critical').length,
            nodes: (c.masterNodes || []).length + (c.workerNodes || []).length, controlPlanes: (c.masterNodes || []).length,
            addons: Object.entries(c.addons || {}).filter(([, v]) => v).map(([k]) => k)
        }
    }).sort((a, b) => (a.risk?.score ?? 101) - (b.risk?.score ?? 101))

    // Kubernetes versions: who is behind, and how far apart the fleet is
    const versions = {}
    for (const c of clusters) (versions[c.k8sVersion || '?'] ||= []).push(c.clusterName)
    const minors = clusters.map(c => minor(c.k8sVersion)).filter(Boolean)
    const k8s = {
        versions: Object.entries(versions).map(([v, names]) => ({ version: v, clusters: names, supported: minor(v) ? LATEST_K8S_MINOR - minor(v) <= 2 : null })).sort((a, b) => (minor(b.version) || 0) - (minor(a.version) || 0)),
        spread: minors.length ? Math.max(...minors) - Math.min(...minors) : 0
    }

    // add-ons running different versions on different clusters
    const byAddon = {}
    for (const c of clusters) for (const [k, on] of Object.entries(c.addons || {})) {
        if (!on) continue
        const v = addonVersion(c.id, k) || 'unknown'
        ;((byAddon[k] ||= {})[v] ||= []).push(c.clusterName)
    }
    const addonDrift = Object.entries(byAddon).filter(([, vs]) => Object.keys(vs).length > 1)
        .map(([key, vs]) => ({ addon: key, versions: Object.entries(vs).map(([version, names]) => ({ version, clusters: names })) }))

    // the same problem on several clusters
    const groups = new Map()
    for (const i of incidents) {
        const w = workloadName(i)
        const key = w ? `${i.reason}|${i.namespace || ''}/${w}` : `${i.reason}|`
        const g = groups.get(key) || { reason: i.reason, label: reasonLabel(i.reason), workload: w ? `${i.namespace ? `${i.namespace}/` : ''}${w}` : null, clusters: new Set(), incidents: [] }
        g.clusters.add(i.clusterName); g.incidents.push(i.id)
        groups.set(key, g)
    }
    const shared = [...groups.values()].filter(g => g.clusters.size >= (g.workload ? 2 : 3))
        .map(g => ({ ...g, clusters: [...g.clusters] })).sort((a, b) => b.clusters.length - a.clusters.length)

    const level = (l) => rows.filter(r => r.risk?.level === l).length
    return {
        clusters: rows, k8s, addonDrift, shared,
        totals: { clusters: rows.length, open: incidents.length, critical: incidents.filter(i => i.severity === 'critical').length, high: level('high'), medium: level('medium'), low: level('low'), unsupported: k8s.versions.filter(v => v.supported === false).reduce((a, v) => a + v.clusters.length, 0) }
    }
}

export function fleetText(f) {
    return [
        `${f.totals.clusters} clusters: ${f.totals.high} high risk, ${f.totals.medium} medium, ${f.totals.low} low; ${f.totals.open} open problems (${f.totals.critical} critical).`,
        `Clusters (riskiest first): ${f.clusters.map(c => `${c.name} (Kubernetes ${c.k8sVersion}, risk ${c.risk?.score ?? '?'}${c.risk?.top ? ` — ${c.risk.top}` : ''}, ${c.open} open)`).join('; ')}`,
        `Kubernetes versions: ${f.k8s.versions.map(v => `${v.version}${v.supported === false ? ' (out of support)' : ''}: ${v.clusters.join(', ')}`).join('; ')}`,
        f.addonDrift.length ? `Add-ons on different versions: ${f.addonDrift.map(d => `${d.addon}: ${d.versions.map(v => `${v.version} on ${v.clusters.join(', ')}`).join(' / ')}`).join('; ')}` : 'Add-ons: same versions everywhere.',
        f.shared.length ? `Same problem on several clusters: ${f.shared.map(s => `${s.label}${s.workload ? ` on ${s.workload}` : ''} — ${s.clusters.join(', ')}`).join('; ')}` : 'No problem shared by several clusters.'
    ].join('\n')
}
