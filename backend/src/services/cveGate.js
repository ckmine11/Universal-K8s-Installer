// CVE deploy gate: before an app is deployed into an environment with a CVE
// policy, the images it will run are checked against what the Trivy Operator
// already found in this cluster. "block" stops the deploy when an image has
// critical (or high) vulnerabilities; "warn" lets it through with the list.
// An image Trivy has not scanned yet is reported, never blocked.
import YAML from 'yaml'

/** Every container image in rendered manifests (containers and initContainers). */
export function imagesOf(manifest) {
    const out = new Set()
    const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk)
        if (!v || typeof v !== 'object') return
        for (const k of ['containers', 'initContainers']) if (Array.isArray(v[k])) for (const c of v[k]) if (typeof c?.image === 'string' && c.image) out.add(c.image)
        for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x)
    }
    for (const doc of YAML.parseAllDocuments(String(manifest || ''))) { try { walk(doc.toJS()) } catch { } }
    return [...out].sort()
}

/** "docker.io/library/nginx:1.25@sha256:…" → "nginx:1.25" — the way the Security view names images. */
export function normImage(s) {
    let x = String(s || '').trim().replace(/@sha256:[0-9a-f]+$/i, '')
    x = x.replace(/^(index\.)?docker\.io\//, '').replace(/^library\//, '')
    if (!/:[^/]+$/.test(x)) x += ':latest'
    return x
}

/**
 * images × the Trivy reports (parseSecurity output) under a policy →
 * { blocked, failing: [{ image, critical, high, cves }], unscanned: [image], passed: [image] }
 */
export function checkImages(images, security, policy) {
    const severity = policy?.severity === 'HIGH' ? 'HIGH' : 'CRITICAL'
    const byImage = new Map()
    for (const r of security?.reports || []) {
        if (!r.image) continue
        const k = normImage(r.image)
        const cur = byImage.get(k)
        // newest scan of that image
        if (!cur || (r.updatedAt || '') > (cur.updatedAt || '')) byImage.set(k, r)
    }
    const failing = [], unscanned = [], passed = []
    for (const img of images) {
        const r = byImage.get(normImage(img))
        if (!r) { unscanned.push(img); continue }
        const bad = r.counts.critical + (severity === 'HIGH' ? r.counts.high : 0)
        if (bad > 0) failing.push({ image: img, critical: r.counts.critical, high: r.counts.high, cves: r.vulns.filter(v => severity === 'HIGH' || v.severity === 'CRITICAL').slice(0, 5).map(v => v.id) })
        else passed.push(img)
    }
    return { mode: policy?.mode || 'off', severity, blocked: policy?.mode === 'block' && failing.length > 0, failing, unscanned, passed }
}

/** One line for errors and the audit trail. */
export const gateText = (g) => g.failing.map(f => `${f.image} (${f.critical} critical${g.severity === 'HIGH' ? `, ${f.high} high` : ''}${f.cves.length ? `: ${f.cves.join(', ')}` : ''})`).join('; ')
