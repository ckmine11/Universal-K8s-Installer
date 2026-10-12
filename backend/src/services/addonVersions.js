import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// New add-on versions, found automatically: every 12 hours KubeEZ reads the
// official Helm repositories of the add-ons (index.yaml), keeps the newest
// stable release of each version line and offers the ones newer than what
// KubeEZ has tested. Installed add-ons with a newer version → an "Update"
// notice in the UI and, once per version, an alert ("Add-on update available").
// Nothing is upgraded by itself — a person picks the version and applies it
// (Helm rolls back if it fails; one-line-at-a-time add-ons stay one line at a time).

const FILE = path.join(DATA_DIR, 'addon-versions.json')
const EVERY_MS = 12 * 3600e3
const FETCH_TIMEOUT_MS = 60e3

// ── versions ─────────────────────────────────────────────────────────────────
export const semver = (v) => (String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/) || []).slice(1, 4).map(n => Number(n || 0))
export function cmpVersion(a, b) {
    const x = semver(a), y = semver(b)
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
    return 0
}
const minorKey = (v) => semver(v).slice(0, 2).join('.')
const stable = (v) => /^v?\d+\.\d+\.\d+$/.test(String(v || ''))

/** kubeVersion ">=1.25.0-0", ">= 1.22.0-0 <1.33.0-0" → [minMinor, maxMinor] */
export function kubeRange(s) {
    const str = String(s || '')
    const min = str.match(/>=?\s*v?1\.(\d+)/)
    const max = str.match(/<\s*v?1\.(\d+)/)
    const maxEq = str.match(/<=\s*v?1\.(\d+)/)
    return [min ? Number(min[1]) : 0, maxEq ? Number(maxEq[1]) : max ? Number(max[1]) - 1 : 99]
}

/**
 * The releases of one chart in a Helm repository index (index.yaml), read
 * line by line (repository indexes are large — no full YAML parse needed).
 */
export function chartReleases(indexText, chart) {
    const lines = String(indexText || '').replace(/\r/g, '').split('\n')
    const start = lines.indexOf(`  ${chart}:`)
    if (start < 0) return []
    const out = []
    let cur = null
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i]
        if (/^ {2}[A-Za-z0-9._-]+:\s*$/.test(l) || /^[A-Za-z]/.test(l)) break
        if (l.startsWith('  - ')) { cur = {}; out.push(cur) }
        const field = /^ {4}(version|appVersion|kubeVersion|created|deprecated): ?["']?([^"'\n]*)["']?\s*$/.exec(l.startsWith('  - ') ? '    ' + l.slice(4) : l)
        if (field && cur) cur[field[1]] = field[2].trim()
    }
    return out.filter(r => r.version)
}

/** Newest stable release of each app version line (e.g. 1.21.x), newest first */
export function latestPerLine(releases) {
    const best = new Map()
    for (const r of releases) {
        if (r.deprecated === 'true' || !stable(r.version) || (r.appVersion && !stable(r.appVersion))) continue
        const app = r.appVersion || r.version
        const k = minorKey(app)
        const cur = best.get(k)
        if (!cur || cmpVersion(app, cur.appVersion || cur.version) > 0 || (cmpVersion(app, cur.appVersion || cur.version) === 0 && cmpVersion(r.version, cur.version) > 0)) best.set(k, r)
    }
    return [...best.values()].sort((a, b) => cmpVersion(b.appVersion || b.version, a.appVersion || a.version))
}

/**
 * Which repository charts an add-on uses (from its definition): the first
 * release decides the version; the others follow their newest release.
 */
export function chartSources(def) {
    const v = def.versions[0]
    // charts map: release name → chart version; release objects tell repo + chart name
    const sample = { clusterId: 'c', k8sMinor: 35, nodeCount: 3, workerCount: 2, addons: { longhorn: true, monitoring: true }, velero: { bucket: 'b' } }
    let releases
    try {
        const s = def.validate({ ...Object.fromEntries(def.fields.map(f => [f.key, f.default])), ...(def.ns === 'metallb-system' ? { addresses: '192.0.2.10-192.0.2.20' } : {}) }, sample)
        releases = def.releases(s, sample, v)
    } catch { return [] }
    if (releases.some(r => r.local)) return []
    // the key each release reads its version from (release name or chart name)
    const keys = Object.keys(v.charts)
    return releases.map(r => ({ release: r.name, chart: r.chart, repo: r.repo, key: keys.find(k => v.charts[k] === r.version) || r.name }))
}

/**
 * Versions to offer beyond the tested ones: newer version lines, and newer
 * patches of tested lines. index: { [repoUrl]: indexText }.
 */
export function discoverFor(def, indexes) {
    if (def.autoUpdate === false) return []
    const sources = chartSources(def)
    if (!sources.length) return []
    const [primary, ...others] = sources
    const text = indexes[primary.repo.url]
    if (!text) return []
    const lines = latestPerLine(chartReleases(text, primary.chart))
    const known = def.versions
    const newestKnown = known.reduce((m, v) => cmpVersion(v.app, m) > 0 ? v.app : m, '0.0.0')
    const companions = {}
    for (const o of others) {
        const t = indexes[o.repo.url]
        const latest = t ? latestPerLine(chartReleases(t, o.chart))[0] : null
        if (!latest) return []   // a companion chart we cannot resolve: offer nothing
        companions[o.key] = latest.version
    }
    const out = []
    for (const r of lines) {
        const app = r.appVersion || r.version
        const sameLine = known.find(k => minorKey(k.app) === minorKey(app))
        const newer = sameLine ? cmpVersion(app, sameLine.app) > 0 : cmpVersion(app, newestKnown) > 0
        if (!newer || known.some(k => k.id === r.version)) continue
        out.push({
            id: r.version, app: /^v/.test(known[0].app) && !/^v/.test(app) ? `v${app}` : app,
            charts: { [primary.key]: r.version, ...companions },
            kube: r.kubeVersion ? kubeRange(r.kubeVersion) : undefined,
            tested: false, released: r.created ? r.created.slice(0, 10) : null
        })
    }
    return out
}

// ── store + schedule ─────────────────────────────────────────────────────────
class AddonVersionService {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return { addons: {}, notified: {} } } }
    _write(d) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(d, null, 2)) }

    /** Versions found upstream (not yet tested by KubeEZ), per add-on */
    discovered(key) { return this._read().addons?.[key] || [] }
    lastCheck() { const d = this._read(); return { at: d.fetchedAt || null, errors: d.errors || [] } }

    /** Read the repositories now. fetchText(url) → text (injectable for tests). */
    async checkNow({ fetchText = defaultFetch } = {}) {
        const { HELM_ADDONS } = await import('../config/helmAddons.js')
        const urls = new Set()
        for (const def of Object.values(HELM_ADDONS)) for (const s of chartSources(def)) urls.add(s.repo.url)
        const indexes = {}, errors = []
        await Promise.all([...urls].map(async (u) => {
            try { indexes[u] = await fetchText(`${u.replace(/\/+$/, '')}/index.yaml`) } catch (e) { errors.push(`${u}: ${String(e.message).slice(0, 120)}`) }
        }))
        const d = this._read()
        d.addons ||= {}
        for (const [key, def] of Object.entries(HELM_ADDONS)) {
            const sources = chartSources(def)
            // keep what was found before when a repository was not reachable this time
            if (sources.some(s => !indexes[s.repo.url])) continue
            d.addons[key] = discoverFor(def, indexes)
        }
        d.fetchedAt = new Date().toISOString()
        d.errors = errors
        this._write(d)
        return { fetchedAt: d.fetchedAt, errors, found: Object.fromEntries(Object.entries(d.addons).filter(([, v]) => v.length).map(([k, v]) => [k, v.map(x => x.id)])) }
    }

    /** Once per cluster + add-on + version: was this update already announced? */
    markNotified(clusterId, key, version) {
        const d = this._read()
        d.notified ||= {}
        const id = `${clusterId}|${key}|${version}`
        if (d.notified[id]) return false
        d.notified[id] = new Date().toISOString()
        this._write(d)
        return true
    }

    start() {
        if (this.timer) return
        const tick = () => this.checkNow().then(() => announceUpdates()).catch(e => console.warn('[AddonVersions] check failed:', e.message))
        setTimeout(tick, 60e3).unref?.()
        this.timer = setInterval(tick, EVERY_MS)
        this.timer.unref?.()
    }
}

async function defaultFetch(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'user-agent': 'KubeEZ add-on update check' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.text()
}

export const addonVersionService = new AddonVersionService()

/** Alert once per cluster / add-on / new version (Alerts → "Add-on update available") */
export async function announceUpdates() {
    const { clusterStore } = await import('./clusterStore.js')
    const { availableUpdates } = await import('./addonSettings.js')
    const { notifier } = await import('./notifier.js')
    let sent = 0
    for (const c of await clusterStore.getClusters()) {
        if (!c.orgId) continue
        for (const u of availableUpdates(c)) {
            if (!addonVersionService.markNotified(c.id, u.key, u.latest.id)) continue
            notifier.emit(c.orgId, {
                type: 'addon_update', severity: 'info', key: `addon-update|${c.id}|${u.key}|${u.latest.id}`,
                title: `Update available: ${u.label} ${u.latest.app}`,
                text: `${c.clusterName || c.id} runs ${u.label} ${u.currentApp}.${u.step && u.step.id !== u.latest.id ? ` Next step: ${u.step.app} (one release line at a time).` : ''}${u.latest.tested ? '' : ' New release — not yet tested by KubeEZ; Helm rolls back automatically if it does not come up.'} Open the cluster → Add-ons → Settings to update.`,
                clusterId: c.id, clusterName: c.clusterName, link: `/cluster/${c.id}?tab=addons&section=manage`
            })
            sent++
        }
    }
    return sent
}
