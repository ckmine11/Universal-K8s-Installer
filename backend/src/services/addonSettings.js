import fs from 'fs'
import path from 'path'
import YAML from 'yaml'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { HELM_ADDONS, isHelmAddon, defaultSettings } from '../config/helmAddons.js'

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
    return {
        nodeIps: nodes.map(n => n.ip).filter(Boolean),
        vip: cluster.controlPlaneVip || null,
        workerCount: (cluster.workerNodes || []).length,
        addons: { ...(cluster.addons || {}) }
    }
}

/**
 * Everything one install / change needs: validated settings, the Helm releases
 * with their final values (form → advanced YAML → locked), and the shell pieces.
 * Throws a 400 with the reason when something is not acceptable.
 */
export function buildPlan(key, cluster, { settings, advanced, version } = {}) {
    if (!isHelmAddon(key)) throw bad('Unknown add-on')
    const a = HELM_ADDONS[key]
    const v = version ? a.versions.find(x => x.id === version) : a.versions[0]
    if (!v) throw bad(`Version ${version} is not offered for ${a.label} — choose one of ${a.versions.map(x => x.id).join(', ')}`)
    const ctx = clusterContext(cluster)
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
    return {
        key, label: a.label, ns: a.ns, version: v.id, app: v.app,
        settings: clean, advanced: String(advanced || ''), ignored,
        releases, pre: a.pre ? a.pre(clean, ctx, v) : '', post
    }
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
    const files = {
        releases: plan.releases.map(r => [r.name, r.repo.name, r.repo.url, r.chart, r.version].join('|')).join('\n') + '\n',
        namespace: `${plan.ns}\n`
    }
    for (const r of plan.releases) files[`${r.name}.values.yaml`] = JSON.stringify(r.values, null, 2) + '\n'
    if (plan.pre) files['pre.sh'] = plan.pre + '\n'
    if (plan.post?.manifests?.length) files['post.yaml'] = plan.post.manifests.map(m => JSON.stringify(m)).join('\n---\n') + '\n'
    if (plan.post?.script) files['post.sh'] = plan.post.script + '\n'
    return files
}

/** One shell command that writes the plan files on the node (base64 — no quoting issues) */
export function writePlanCommand(key, files) {
    if (!/^[a-z0-9-]+$/.test(key)) throw new Error('bad key')
    const dir = `/etc/kubeez/addons/${key}`
    const parts = [`sudo rm -rf ${dir} && sudo mkdir -p ${dir}`]
    for (const [name, content] of Object.entries(files)) {
        if (!/^[a-z0-9.-]+$/.test(name)) throw new Error('bad file name')
        parts.push(`echo ${Buffer.from(content, 'utf8').toString('base64')} | base64 -d | sudo tee ${dir}/${name} >/dev/null`)
    }
    return parts.join(' && ')
}
