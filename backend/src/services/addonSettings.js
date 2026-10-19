import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { fileURLToPath } from 'url'
import { HELM_ADDONS, isHelmAddon, defaultSettings, versionFits, versionForRunning, allVersions, findVersion } from '../config/helmAddons.js'
import { minorOf } from '../config/addons/common.js'
import { volumeBackupStore } from './volumeBackupStore.js'

const CHARTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../automation/charts')

// Settings of the Helm add-ons, per cluster:
//   applied   what runs in the cluster now (after a successful install / change)
//   pending   what a running job is applying
//   history   the last 20 changes, with who, when and the result
// A failed change leaves `applied` as it was — Helm rolled the add-on back.
const FILE = path.join(DATA_DIR, 'addon-settings.json')
const HISTORY_MAX = 20
const ADVANCED_MAX = 64 * 1024

const bad = (msg) => Object.assign(new Error(msg), { status: 400 })

class AddonSettingsStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }

    get(clusterId, key) {
        return this._read()[clusterId]?.[key] || { applied: null, pending: null, history: [] }
    }

    /** A job starts applying these settings */
    setPending(clusterId, key, desired, { by, jobId }) {
        const all = this._read()
        const c = all[clusterId] ||= {}
        const r = c[key] ||= { applied: null, pending: null, history: [] }
        r.pending = { ...desired, by, jobId, at: new Date().toISOString() }
        this._write(all)
    }

    /** The job finished: success → applied; failure → applied stays, history says why */
    finish(clusterId, key, jobId, { ok, error } = {}) {
        const all = this._read()
        const r = all[clusterId]?.[key]
        if (!r?.pending || (jobId && r.pending.jobId !== jobId)) return
        const { jobId: _j, ...desired } = r.pending
        r.history = [{ at: new Date().toISOString(), by: desired.by, version: desired.version, settings: desired.settings, advanced: !!desired.advanced, ok: !!ok, error: ok ? null : String(error || 'failed').slice(0, 500) }, ...(r.history || [])].slice(0, HISTORY_MAX)
        if (ok) r.applied = { ...desired, at: new Date().toISOString() }
        r.pending = null
        this._write(all)
    }

    /** Uninstalled: nothing applied any more (history kept — reinstall offers the last settings) */
    removed(clusterId, key) {
        const all = this._read()
        const r = all[clusterId]?.[key]
        if (!r) return
        if (r.applied) r.lastSettings = { settings: r.applied.settings, advanced: r.applied.advanced, version: r.applied.version }
        r.applied = null; r.pending = null
        this._write(all)
    }

    dropCluster(clusterId) {
        const all = this._read()
        if (all[clusterId]) { delete all[clusterId]; this._write(all) }
    }
}
export const addonSettingsStore = new AddonSettingsStore()

// ── Values ───────────────────────────────────────────────────────────────────
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)
export function deepMerge(base, over) {
    if (!isObj(base) || !isObj(over)) return over === undefined ? base : over
    const out = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v
    return out
}
const getPath = (o, p) => p.split('.').reduce((a, k) => (isObj(a) ? a[k] : undefined), o)
function setPath(o, p, v) {
    const ks = p.split('.'); let cur = o
    for (const k of ks.slice(0, -1)) cur = (isObj(cur[k]) ? cur[k] : (cur[k] = {}))
    cur[ks.at(-1)] = v
}

/**
 * The advanced YAML → { [release]: values }. One release: the YAML is its
 * values. Several (Loki + Fluent Bit): top-level keys are the release names.
 */
export function parseAdvanced(key, text, releaseNames) {
    const src = String(text || '').trim()
    if (!src) return {}
    if (src.length > ADVANCED_MAX) throw bad('Advanced values: at most 64 KB')
    let doc
    try { doc = YAML.parse(src, { maxAliasCount: 50 }) } catch (e) { throw bad(`Advanced values: not valid YAML — ${String(e.message).split('\n')[0]}`) }
    if (doc == null) return {}
    if (!isObj(doc)) throw bad('Advanced values: must be a YAML map (key: value)')
    if (releaseNames.length === 1) return { [releaseNames[0]]: doc }
    const unknown = Object.keys(doc).filter(k => !releaseNames.includes(k))
    if (unknown.length) throw bad(`Advanced values: top-level keys must be ${releaseNames.join(' or ')} (one per Helm release) — not ${unknown.join(', ')}`)
    for (const [k, v] of Object.entries(doc)) if (v != null && !isObj(v)) throw bad(`Advanced values: "${k}" must be a map`)
    return doc
}

/** Facts about the cluster that settings are checked against */
export function clusterContext(cluster) {
    const nodes = [...(cluster.masterNodes || []), ...(cluster.workerNodes || [])]
    const clusterId = cluster.originalClusterId || cluster.id || null
    // where Velero stores backups (Backups → Volume Backups) — no keys here
    let velero = null
    try {
        const c = clusterId ? volumeBackupStore.effective(clusterId, cluster.orgId) : null
        if (c?.bucket) velero = { provider: c.provider, endpoint: c.endpoint, region: c.region, bucket: c.bucket, prefix: c.prefix, insecureTls: !!c.insecureTls }
    } catch { /* not configured */ }
    return {
        clusterId, orgId: cluster.orgId || null,
        k8sMinor: Number(String(cluster.k8sVersion || '').split('.')[1]) || null,
        nodeIps: nodes.map(n => n.ip).filter(Boolean),
        nodeCount: nodes.length,
        vip: cluster.controlPlaneVip || null,
        workerCount: (cluster.workerNodes || []).length,
        addons: Object.fromEntries(Object.entries(cluster.addons || {}).map(([k, v]) => [k === 'certManager' ? 'cert-manager' : k, v])),
        velero
    }
}

/** Upgrade one release line at a time: the node checks what runs before anything changes */
function stepCheck(a, v) {
    // the target's line and the line right below it (tested and newly found versions together)
    const lines = [...new Set(allVersions(a.key).map(x => minorOf(x.app)))]
    const allowed = [minorOf(v.app), lines[lines.indexOf(minorOf(v.app)) + 1]].filter(Boolean)
    const ref = a.probe.replace(/[^a-z0-9/.-]/g, '')
    return [
        `CUR=$(kubectl -n ${a.ns} get ${ref} -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -1)`,
        'if [ -n "$CUR" ]; then',
        '    CURMM=$(echo "$CUR" | cut -d. -f1,2)',
        `    case "$CURMM" in ${allowed.join('|')}) ;; *) fail VERSION_STEP "${a.label} $CUR runs now; ${v.app} is not the next step from it — ${a.label} is upgraded one release line at a time." "Choose the version of the line right after $CURMM (or the one that runs now), apply, then continue." ;; esac`,
        'fi'
    ].join('\n')
}

/**
 * Everything one install / change needs: validated settings, the Helm releases
 * with their final values (form → advanced YAML → locked), and the shell pieces.
 * Throws a 400 with the reason when something is not acceptable.
 */
export function buildPlan(key, cluster, { settings, advanced, version } = {}, { runningApp } = {}) {
    if (!isHelmAddon(key)) throw bad('Unknown add-on')
    const a = HELM_ADDONS[key]
    const ctx = clusterContext(cluster)
    // the chosen version; else the line that runs now (takeover / repair); else the newest that fits
    const v = version ? findVersion(key, version) : (versionForRunning(key, runningApp) || a.versions.find(x => versionFits(x, ctx.k8sMinor)) || a.versions[0])
    if (!v) throw bad(`Version ${version} is not offered for ${a.label} — choose one of ${a.versions.map(x => x.id).join(', ')}`)
    if (!versionFits(v, ctx.k8sMinor)) throw bad(`${a.label} ${v.id} needs Kubernetes 1.${v.kube[0]} or newer — this cluster runs 1.${ctx.k8sMinor}. Choose an older version.`)
    const clean = a.validate({ ...defaultSettings(key), ...(settings || {}) }, ctx)
    const releases = a.releases(clean, ctx, v)
    const adv = parseAdvanced(key, advanced, releases.map(r => r.name))
    const ignored = []
    for (const r of releases) {
        const base = r.values
        r.values = deepMerge(base, adv[r.name] || {})
        // KubeEZ needs these to find, check and repair the add-on
        for (const p of a.locked?.[r.name] || []) {
            const want = getPath(base, p)
            if (JSON.stringify(getPath(r.values, p)) !== JSON.stringify(want)) {
                if (getPath(adv[r.name] || {}, p) !== undefined) ignored.push(`${r.name}: ${p}`)
                setPath(r.values, p, want)
            }
        }
    }
    const post = a.post ? a.post(clean, ctx, v) : { manifests: [], script: '' }
    const pre = [a.stepUpgrade && a.probe ? stepCheck({ ...a, key }, v) : '', a.pre ? a.pre(clean, ctx, v) : ''].filter(Boolean).join('\n')
    return {
        key, label: a.label, ns: a.ns, version: v.id, app: v.app,
        settings: clean, advanced: String(advanced || ''), ignored,
        releases, pre, post,
        takeover: a.takeover ? { detect: a.takeover.detect, migrate: a.takeover.migrate ? a.takeover.migrate(clean, ctx, v) : '' } : null
    }
}

/**
 * Add-ons on this cluster with a newer version than the one KubeEZ applied
 * (only add-ons KubeEZ manages with Helm — older installs show "Not Helm-managed yet").
 * step: for one-line-at-a-time add-ons, the version of the next line (what Apply may go to now).
 */
export function availableUpdates(cluster) {
    const k8sMinor = Number(String(cluster.k8sVersion || '').split('.')[1]) || null
    const out = []
    for (const key of Object.keys(HELM_ADDONS)) {
        const applied = addonSettingsStore.get(cluster.id, key).applied
        if (!applied?.version) continue
        const versions = allVersions(key)
        const cur = versions.find(v => v.id === applied.version)
        if (!cur) continue
        const fit = versions.filter(v => versionFits(v, k8sMinor))
        const latest = fit[0]
        if (!latest || cmpApp(latest.app, cur.app) <= 0) continue
        let step = null
        if (HELM_ADDONS[key].stepUpgrade) {
            const curLine = minorOf(cur.app)
            const lines = [...new Set(versions.map(v => minorOf(v.app)))]   // newest first
            const sameLineNewer = fit.find(v => minorOf(v.app) === curLine && cmpApp(v.app, cur.app) > 0)
            const next = lines[lines.indexOf(curLine) - 1]
            step = sameLineNewer || fit.find(v => minorOf(v.app) === next) || null
        }
        out.push({ key, label: HELM_ADDONS[key].label, current: cur.id, currentApp: cur.app,
            latest: { id: latest.id, app: latest.app, tested: !!latest.tested },
            step: step ? { id: step.id, app: step.app, tested: !!step.tested } : null })
    }
    return out
}
const cmpApp = (a, b) => {
    const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
    return 0
}

/** The values as the user sees them (YAML, one document per release) */
export function valuesYaml(plan) {
    return plan.releases.map(r => `# ${r.name} — chart ${r.chart} ${r.version}\n${YAML.stringify(r.values, { lineWidth: 0 })}`).join('\n')
}

/** Line diff (applied → new) for the preview — small LCS, values are short */
export function lineDiff(before, after) {
    const a = String(before || '').split('\n'), b = String(after || '').split('\n')
    if (a.length * b.length > 4e6) return b.map(l => ({ t: '+', l }))
    const m = a.length, n = b.length
    const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    const out = []; let i = 0, j = 0
    while (i < m && j < n) {
        if (a[i] === b[j]) { out.push({ t: ' ', l: a[i] }); i++; j++ }
        else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', l: a[i++] })
        else out.push({ t: '+', l: b[j++] })
    }
    while (i < m) out.push({ t: '-', l: a[i++] })
    while (j < n) out.push({ t: '+', l: b[j++] })
    return out
}

/**
 * Files the generic installer (addons/helm-addon.sh) reads on the node, under
 * /etc/kubeez/addons/<key>/. Values are JSON (valid YAML for Helm).
 */
export function planFiles(plan) {
    const line = (r) => {
        const flags = [r.local ? 'local' : '', r.crds ? 'crds' : '', r.rollback === false ? 'norollback' : '', r.slow ? 'slow' : '', r.clientSide ? 'csa' : ''].filter(Boolean).join(',') || '-'
        return r.local ? [r.name, 'local', '-', r.local, r.version, flags].join('|') : [r.name, r.repo.name, r.repo.url, r.chart, r.version, flags].join('|')
    }
    const files = {
        releases: plan.releases.map(line).join('\n') + '\n',
        namespace: `${plan.ns}\n`
    }
    for (const r of plan.releases) {
        files[`${r.name}.values.yaml`] = JSON.stringify(r.values, null, 2) + '\n'
        // a chart KubeEZ ships (no upstream chart for it)
        if (r.local) for (const [rel, content] of chartFiles(r.local)) files[`charts/${r.local}/${rel}`] = content
    }
    if (plan.pre) files['pre.sh'] = plan.pre + '\n'
    if (plan.post?.manifests?.length) files['post.yaml'] = plan.post.manifests.map(m => typeof m === 'string' ? m : JSON.stringify(m)).join('\n---\n') + '\n'
    if (plan.post?.script) files['post.sh'] = plan.post.script + '\n'
    if (plan.takeover) {
        files.takeover = plan.takeover.detect + '\n'
        if (plan.takeover.migrate) files['migrate.sh'] = plan.takeover.migrate + '\n'
    }
    return files
}

function chartFiles(name, sub = '') {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('bad chart name')
    const dir = path.join(CHARTS_DIR, name, sub)
    const out = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = sub ? `${sub}/${e.name}` : e.name
        if (e.isDirectory()) out.push(...chartFiles(name, rel))
        else out.push([rel, fs.readFileSync(path.join(dir, e.name), 'utf8').replace(/\r\n/g, '\n')])
    }
    return out
}

/** One shell command that writes the plan files on the node (base64 — no quoting issues) */
// sandbox: an imported cluster — the plan goes to its connection's session folder ($KUBEEZ_ROOT)
export function writePlanCommand(key, files, { sandbox = false } = {}) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error('bad key')
    const dir = sandbox ? `"$KUBEEZ_ROOT"/etc/kubeez/addons/${key}` : `/etc/kubeez/addons/${key}`
    const parts = [`sudo rm -rf ${dir} && sudo mkdir -p ${dir}`]
    const dirs = new Set()
    for (const name of Object.keys(files)) {
        if (!/^[a-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.includes('..')) throw new Error('bad file name')
        if (name.includes('/')) dirs.add(name.slice(0, name.lastIndexOf('/')))
    }
    if (dirs.size) parts.push(`sudo mkdir -p ${[...dirs].map(d => `${dir}/${d}`).join(' ')}`)
    for (const [name, content] of Object.entries(files)) {
        parts.push(`echo ${Buffer.from(content, 'utf8').toString('base64')} | base64 -d | sudo tee ${dir}/${name} >/dev/null`)
    }
    return parts.join(' && ')
}
