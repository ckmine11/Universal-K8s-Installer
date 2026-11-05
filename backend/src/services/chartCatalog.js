// Chart Store: the charts of an https Helm repository (its index.yaml), for
// picking a chart and version. Fetched by the KubeEZ server — in SaaS only from
// public addresses — size-limited and kept an hour. OCI registries have no
// index: there the chart name is typed.
import YAML from 'yaml'
import { assertDirectConnectAllowed } from '../utils/netGuard.js'

const MAX_BYTES = 40 * 1024 * 1024
const TTL = 60 * 60e3
const cache = new Map()   // url (+user) → { at, charts }
const reading = new Map() // url (+user) → the read in progress (one at a time)

const KEEP = 30           // versions listed per chart
const SCAN = 40           // versions read per chart (a few may be deprecated)
const FULL_PARSE_MAX = 8 * 1024 * 1024
const notYaml = () => Object.assign(new Error('The repository index is not valid YAML'), { status: 502 })
const notHelm = () => Object.assign(new Error('This is not a Helm repository (no entries in index.yaml)'), { status: 502 })

// Large repositories (Bitnami: 28 MB, every version ever published) take ~1 GB
// and 10 s of blocked server to parse whole. Helm writes index.yaml in one
// layout — `entries:` at column 0, one key per chart, its versions newest first
// as list items — so each chart's first SCAN items are cut out and parsed on
// their own. null when the text is not in that layout.
function chartChunks(text) {
    const start = /^entries:[ \t]*\r?$/m.exec(text)
    if (!start) return null
    let body = text.slice(start.index + start[0].length + 1)
    const end = body.search(/^[^\s#]/m)   // the next top-level key (generated:, serverInfo:)
    if (end >= 0) body = body.slice(0, end)
    const first = /^( +)[^\s#-]/m.exec(body)
    if (!first) return []
    const keys = [...body.matchAll(new RegExp(`^${first[1]}(?=[^\\s#-])[^\\n]*:[ \\t]*\\r?$`, 'gm'))]
    return keys.map((k, i) => {
        const chunk = body.slice(k.index, i + 1 < keys.length ? keys[i + 1].index : body.length)
        const item = /^( +)- /m.exec(chunk)
        if (!item) return chunk
        const items = chunk.matchAll(new RegExp(`^${item[1]}- `, 'gm'))
        let n = 0
        for (const m of items) if (n++ === SCAN) return chunk.slice(0, m.index)
        return chunk
    })
}

// one chart per step, so the async reader can let other requests in between
function* entriesOf(text) {
    const chunks = chartChunks(text)
    if (chunks) {
        const entries = {}
        let ok = true
        for (const chunk of chunks) {
            let doc
            try { doc = YAML.parse(chunk, { maxAliasCount: 100 }) } catch { ok = false; break }
            if (!doc || typeof doc !== 'object') { ok = false; break }
            Object.assign(entries, doc)
            yield
        }
        if (ok) return entries
    }
    if (text.length > FULL_PARSE_MAX) throw Object.assign(new Error('The repository index is too large to read — type the chart name instead'), { status: 502 })
    let doc
    try { doc = YAML.parse(text, { maxAliasCount: 100 }) } catch { throw notYaml() }
    return doc?.entries
}

function chartsOf(entries) {
    if (!entries || typeof entries !== 'object') throw notHelm()
    return Object.entries(entries).map(([name, list]) => {
        const vs = (Array.isArray(list) ? list : []).filter(v => v && v.version && !v.deprecated)
        const top = vs[0] || {}
        return {
            name, description: String(top.description || '').slice(0, 300) || null, icon: /^https:\/\//.test(top.icon || '') ? String(top.icon).slice(0, 300) : null,
            versions: vs.slice(0, KEEP).map(v => ({ version: String(v.version), appVersion: v.appVersion ? String(v.appVersion) : null, created: v.created || null }))
        }
    }).filter(c => c.versions.length).sort((a, b) => a.name.localeCompare(b.name))
}

/** index.yaml text → [{ name, description, icon, versions: [{ version, appVersion, created }] }] */
export function parseIndex(text) {
    const steps = entriesOf(String(text || ''))
    let r
    do r = steps.next(); while (!r.done)
    return chartsOf(r.value)
}

/** The same, giving the event loop a turn after every chart. */
export async function parseIndexAsync(text) {
    const steps = entriesOf(String(text || ''))
    let r
    while (!(r = steps.next()).done) await new Promise(res => setImmediate(res))
    return chartsOf(r.value)
}

async function fetchIndex(repo, fetchImpl) {
    let u = new URL(`${repo.url}/index.yaml`)
    const first = u.host
    let r
    // redirects are followed by hand: every hop must be a public https address too
    for (let hop = 0; ; hop++) {
        if (u.protocol !== 'https:') throw Object.assign(new Error('The repository redirected to a non-https address'), { status: 502 })
        await assertDirectConnectAllowed(u.hostname)
        const headers = { Accept: 'application/x-yaml, text/yaml, */*', 'User-Agent': 'KubeEZ' }
        // credentials go only to the repository's own host
        if (repo.username && u.host === first) headers.Authorization = `Basic ${Buffer.from(`${repo.username}:${repo.password || ''}`).toString('base64')}`
        r = await fetchImpl(u, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) })
        if (r.status < 300 || r.status >= 400 || !r.headers.get('location')) break
        if (hop >= 3) throw Object.assign(new Error('The repository redirected too many times'), { status: 502 })
        u = new URL(r.headers.get('location'), u)
    }
    if (!r.ok) throw Object.assign(new Error(`The repository answered HTTP ${r.status}${r.status === 401 || r.status === 403 ? ' — check its user name and password' : ''}`), { status: 502 })
    const len = Number(r.headers.get('content-length') || 0)
    if (len > MAX_BYTES) throw Object.assign(new Error('The repository index is too large'), { status: 502 })
    const reader = r.body.getReader()
    const parts = []
    let size = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) { reader.cancel().catch(() => { }); throw Object.assign(new Error('The repository index is too large'), { status: 502 }) }
        parts.push(value)
    }
    return Buffer.concat(parts).toString('utf8')
}

/** Charts of a workspace repository (with credentials), filtered by q. */
export async function listCharts(repo, { q = '', fresh = false, fetchImpl = fetch } = {}) {
    if (repo.url.startsWith('oci://')) return { oci: true, charts: [] }
    const key = `${repo.url}|${repo.username || ''}`
    let hit = cache.get(key)
    if (fresh || !hit || Date.now() - hit.at > TTL) {
        if (!reading.has(key)) reading.set(key, (async () => {
            const h = { at: Date.now(), charts: await parseIndexAsync(await fetchIndex(repo, fetchImpl)) }
            cache.set(key, h)
            if (cache.size > 50) cache.delete(cache.keys().next().value)
            return h
        })().finally(() => reading.delete(key)))
        hit = await reading.get(key)
    }
    const needle = String(q || '').trim().toLowerCase()
    const charts = needle ? hit.charts.filter(c => c.name.toLowerCase().includes(needle) || (c.description || '').toLowerCase().includes(needle)) : hit.charts
    return { oci: false, total: hit.charts.length, charts: charts.slice(0, 200) }
}
export const _test = { clear: () => cache.clear() }
