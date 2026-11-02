import { createHash } from 'crypto'
import { helmScript, RELEASE, NAMESPACE } from './helmApps.js'

// Helm drift: what was changed by hand in a Helm app since it was deployed
// (kubectl edit, kubectl scale, a deleted Service…). For each release, the
// manifest Helm deployed is compared with the live objects by the API server
// itself: `helm get manifest | kubectl diff --server-side` (a dry run — nothing
// changes). Only the fields the chart sets count; fields others add are not
// drift. Replicas of a workload an autoscaler (HPA / KEDA) scales are ignored.
// Restoring = a rollback to the release's current revision (Helm applies its
// manifest again) — the normal rollback with its approvals and freezes.
const KUBECTL = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf timeout 60 kubectl'
const MAX_RELEASES = 40
const MAX_LINES = 80
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// lines that change on every apply or are not the chart's
const NOISE = /^[+-]\s*(generation|resourceVersion|uid|creationTimestamp|kubectl\.kubernetes\.io\/last-applied-configuration|deployment\.kubernetes\.io\/revision):/

/** The script that diffs these releases → marked sections per release. */
export function driftScript(releases) {
    return [
        'T=$(mktemp); D=$(mktemp)',
        ...releases.map(r => {
            if (!NAMESPACE.test(r.namespace) || !RELEASE.test(r.name)) throw Object.assign(new Error('Not a valid release'), { status: 400 })
            const id = `${r.namespace}/${r.name}`
            return [
                `echo '==KZDRIFT:${id}=='`,
                `if HELM get manifest ${q(r.name)} -n ${q(r.namespace)} > "$T" 2>"$D"; then`,
                `  echo '==KZSCALED=='; ${KUBECTL} get hpa -n ${q(r.namespace)} -o jsonpath='{range .items[*]}{.spec.scaleTargetRef.kind}/{.spec.scaleTargetRef.name}{"\\n"}{end}' --request-timeout=20s 2>/dev/null`,
                `  echo '==KZDIFF=='; ${KUBECTL} diff --server-side --force-conflicts --field-manager=kubeez-drift -n ${q(r.namespace)} -f "$T" > "$D" 2>&1; RC=$?; head -c 200000 "$D"; echo; echo "==KZRC:$RC=="`,
                `else echo '==KZERR=='; head -c 400 "$D"; echo; fi`
            ].join('\n')
        }),
        'rm -f "$T" "$D"', `echo '==KZDRIFT_END=='`
    ].join('\n')
}

// "apps.v1.Deployment.shop.web" → { kind, namespace, name } (the file names kubectl diff uses)
export function resourceOf(file) {
    const parts = String(file).split('/').pop().split('.')
    const i = parts.findIndex(p => /^[A-Z]/.test(p))
    if (i < 0) return { kind: null, namespace: null, name: parts.join('.') }
    const rest = parts.slice(i + 1)
    return rest.length === 1 ? { kind: parts[i], namespace: null, name: rest[0] } : { kind: parts[i], namespace: rest[0] || null, name: rest.slice(1).join('.') }
}

/** kubectl diff output → [{ kind, namespace, name, missing, lines }] (only real changes; scaled replicas ignored). */
export function parseDiff(text, scaled = new Set()) {
    const out = []
    for (const block of String(text || '').split(/^diff -u -N /m).slice(1)) {
        const [head, ...body] = block.split('\n')
        const r = resourceOf(head.trim().split(/\s+/)[0])
        const missing = body.some(l => /^@@ -0,0 /.test(l))
        const autoscaled = scaled.has(`${r.kind}/${r.name}`)
        const lines = body.filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)\s/.test(l) && !NOISE.test(l) && !(autoscaled && /^[+-]\s*replicas:/.test(l)))
        if (!lines.length) continue
        out.push({ ...r, missing, lines: lines.slice(0, MAX_LINES), more: Math.max(0, lines.length - MAX_LINES) })
    }
    return out
}

/** The script's output → { "ns/name": { drifted, resources, error? } } */
export function parseDrift(out) {
    const res = {}
    for (const part of String(out || '').split(/^==KZDRIFT:/m).slice(1)) {
        const id = part.slice(0, part.indexOf('=='))
        const err = /==KZERR==\n([\s\S]*)$/.exec(part)
        if (err) { res[id] = { drifted: false, resources: [], error: err[1].replace(/==KZDRIFT_END==/, '').trim().slice(0, 300) || 'helm get manifest failed' }; continue }
        const scaled = new Set(((/==KZSCALED==\n([\s\S]*?)==KZDIFF==/.exec(part) || [])[1] || '').split('\n').map(s => s.trim()).filter(Boolean))
        const diff = (/==KZDIFF==\n([\s\S]*?)==KZRC:(\d+)==/.exec(part) || [])
        const rc = Number(diff[2] ?? -1)
        if (rc > 1 || rc < 0) { res[id] = { drifted: false, resources: [], error: String(diff[1] || 'kubectl diff did not finish').trim().split('\n').filter(l => !/^Warning:/i.test(l)).slice(-3).join(' ').slice(0, 300) }; continue }
        const resources = rc === 1 ? parseDiff(diff[1], scaled) : []
        res[id] = { drifted: resources.length > 0, resources }
    }
    return res
}

/** Drift of these releases ([{ namespace, name }], up to 40) → [{ namespace, release, drifted, resources, error? }] */
export async function checkDrift(cluster, releases, { connect } = {}) {
    const list = releases.slice(0, MAX_RELEASES)
    if (!list.length) return []
    const r = await helmScript(cluster, driftScript(list), { ...(connect ? { connect } : {}), timeoutMs: Math.min(600e3, 60e3 + list.length * 20e3) })
    const out = String(r?.stdout || '')
    if (!out.includes('==KZDRIFT_END==')) {
        const why = String(r?.stderr || '').match(/KZHELM\|[A-Z_]+\|(.*)/)?.[1] || String(r?.stderr || '').trim().slice(0, 200)
        throw Object.assign(new Error(`Could not check drift${why ? `: ${why}` : ''}`), { status: 502 })
    }
    const by = parseDrift(out)
    return list.map(x => ({ namespace: x.namespace, release: x.name, ...(by[`${x.namespace}/${x.name}`] || { drifted: false, resources: [], error: 'not checked' }) }))
}

/** A short fingerprint of a drift (the same drift is alerted once). */
export const driftKey = (d) => createHash('sha256').update(JSON.stringify(d.resources.map(r => [r.kind, r.namespace, r.name, r.lines]))).digest('hex').slice(0, 16)

// ── hourly check → alert when a release drifts (or its drift changes) ──
const seen = new Map()   // "clusterId|ns/release" → driftKey
/** One cluster. deps: list(cluster), check(cluster, releases), notify(cluster, ev), usable(orgId) */
export async function alertCluster(cluster, deps) {
    if (!deps.usable(cluster.orgId)) return { skip: 'feature' }
    const releases = await deps.list(cluster)
    const results = await deps.check(cluster, releases.map(r => ({ namespace: r.namespace, name: r.name })))
    const fresh = []
    for (const d of results) {
        const k = `${cluster.id}|${d.namespace}/${d.release}`
        if (!d.drifted) { seen.delete(k); continue }
        const fp = driftKey(d)
        if (seen.get(k) === fp) continue
        seen.set(k, fp); fresh.push(d)
    }
    if (fresh.length) {
        deps.notify(cluster, {
            severity: 'warning', title: `Helm drift on ${cluster.clusterName}: ${fresh.map(d => `${d.namespace}/${d.release}`).slice(0, 3).join(', ')}${fresh.length > 3 ? ` +${fresh.length - 3}` : ''}`,
            text: fresh.slice(0, 5).map(d => `${d.namespace}/${d.release}: ${d.resources.slice(0, 3).map(r => `${r.kind} ${r.name}${r.missing ? ' (deleted)' : ` (${r.lines.length} line${r.lines.length === 1 ? '' : 's'} changed)`}`).join(', ')}`).join('\n') +
                '\nChanged by hand since Helm deployed it — restore it in the cluster\'s Apps tab, or put the change into the chart values.'
        })
    }
    return { drifted: fresh.length }
}
export const _test = { reset: () => seen.clear() }

export async function startHelmDriftAlerts() {
    const [{ clusterStore }, { features }, helm, { notifier }] = await Promise.all([import('./clusterStore.js'), import('./features.js'), import('./helmApps.js'), import('./notifier.js')])
    const deps = {
        usable: (orgId) => features.usable(orgId, 'helmDrift') && features.usable(orgId, 'helmApps'),
        list: (c) => helm.listReleases(c),
        check: (c, rs) => checkDrift(c, rs),
        notify: (c, ev) => notifier.emit(c.orgId, { type: 'helm_drift', key: `drift|${c.id}|${ev.title}`, clusterId: c.id, clusterName: c.clusterName, link: `/cluster/${c.id}?tab=apps`, ...ev })
    }
    const run = async () => {
        for (const c of await clusterStore.getClusters().catch(() => [])) {
            if (c.status === 'failed' && c.mode === 'install') continue
            await alertCluster(c, deps).catch(() => { })
        }
    }
    setTimeout(run, 5 * 60e3).unref?.()
    setInterval(run, 60 * 60e3).unref?.()
}
