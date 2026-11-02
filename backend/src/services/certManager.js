import { KUBECTL, crdSection, splitSections, listError } from './kubeList.js'

// cert-manager dashboard: the Certificates of a cluster with their expiry and
// state, the Issuers / ClusterIssuers, and ACME Challenges that are stuck — in
// one read. "Renew now" asks cert-manager to issue a certificate again (what
// `cmctl renew` does: an Issuing condition). KubeEZ never reads the TLS
// Secrets themselves; the dates come from the Certificate's status.
const MARK = 'KZCERT'
const SOURCES = [
    { key: 'CERT', resource: 'certificates.cert-manager.io' },
    { key: 'ISSUER', resource: 'issuers.cert-manager.io' },
    { key: 'CISSUER', resource: 'clusterissuers.cert-manager.io' },
    { key: 'CHAL', resource: 'challenges.acme.cert-manager.io' }
]
export const CERT_SCRIPT = [...SOURCES.map(s => crdSection(MARK, s.key, s.resource)), `echo '==${MARK}:END=='`].join('; ')
export const EXPIRING_DAYS = 14
const str = (v, n = 300) => v == null || v === '' ? null : String(v).slice(0, n)
const at = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : new Date(t).toISOString() }
const cond = (o, type) => (o?.status?.conditions || []).find(c => c.type === type) || null

/** A Certificate → its state. state: ok | expiring | expired | failing | issuing | pending */
export function certOf(c, now = Date.now()) {
    const md = c.metadata || {}, spec = c.spec || {}, st = c.status || {}
    const ready = cond(c, 'Ready'), issuing = cond(c, 'Issuing')
    const notAfter = at(st.notAfter)
    const daysLeft = notAfter ? Math.floor((Date.parse(notAfter) - now) / 86400e3) : null
    let state = 'pending'
    if (notAfter && Date.parse(notAfter) <= now) state = 'expired'
    else if (issuing?.status === 'True') state = 'issuing'
    else if (ready?.status === 'False') state = 'failing'
    else if (ready?.status === 'True') state = daysLeft != null && daysLeft < EXPIRING_DAYS ? 'expiring' : 'ok'
    return {
        namespace: md.namespace, name: md.name,
        dnsNames: [...new Set([spec.commonName, ...(spec.dnsNames || [])].filter(Boolean))].slice(0, 20).map(d => str(d, 253)),
        secretName: str(spec.secretName, 253),
        issuer: { kind: spec.issuerRef?.kind || 'Issuer', name: str(spec.issuerRef?.name, 253) },
        state, daysLeft, notAfter, notBefore: at(st.notBefore), renewalTime: at(st.renewalTime), revision: st.revision ?? null,
        reason: str(ready?.status === 'True' ? null : (issuing?.reason || ready?.reason), 120),
        message: str(ready?.status === 'True' ? null : (issuing?.message || ready?.message)),
        failedAt: at(st.lastFailureTime)
    }
}
const TYPES = ['acme', 'ca', 'selfSigned', 'vault', 'venafi']
export function issuerOf(i, kind) {
    const md = i.metadata || {}, spec = i.spec || {}, ready = cond(i, 'Ready')
    return {
        kind, namespace: kind === 'ClusterIssuer' ? null : md.namespace, name: md.name,
        type: TYPES.find(t => spec[t]) || Object.keys(spec)[0] || 'unknown',
        acmeServer: str(spec.acme?.server, 200),
        ready: ready?.status === 'True', message: str(ready?.status === 'True' ? null : ready?.message)
    }
}
export function challengeOf(c) {
    const md = c.metadata || {}, spec = c.spec || {}, st = c.status || {}
    return { namespace: md.namespace, name: md.name, dnsName: str(spec.dnsName, 253), type: str(spec.type, 20), state: str(st.state, 30) || 'pending', presented: !!st.presented, reason: str(st.reason), createdAt: at(md.creationTimestamp) }
}

/** The script's output → { installed: state, certificates, issuers, challenges } */
export function parseCerts(out, now = Date.now()) {
    const s = splitSections(out, MARK)
    const lists = {}, errors = {}
    for (const src of SOURCES) {
        if (s[`${src.key}_ERR`] != null) { errors[src.key] = listError(s[`${src.key}_ERR`], src.resource); lists[src.key] = []; continue }
        try { lists[src.key] = JSON.parse(s[src.key] || '{"items":[]}').items || [] } catch { lists[src.key] = []; errors[src.key] = { state: 'error', message: 'The list is too large or could not be read.' } }
    }
    const tool = errors.CERT || { state: 'ok' }
    return {
        tool,
        certificates: lists.CERT.map(c => certOf(c, now)).filter(c => c.name).sort((a, b) => RANK[a.state] - RANK[b.state] || (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999) || a.name.localeCompare(b.name)),
        issuers: [...lists.CISSUER.map(i => issuerOf(i, 'ClusterIssuer')), ...lists.ISSUER.map(i => issuerOf(i, 'Issuer'))].filter(i => i.name),
        challenges: lists.CHAL.map(challengeOf).filter(c => c.name && c.state !== 'valid')
    }
}
const RANK = { expired: 0, failing: 1, expiring: 2, issuing: 3, pending: 4, ok: 5 }

/** Counts for the header cards. */
export function summarizeCerts(r) {
    const n = (s) => r.certificates.filter(c => c.state === s).length
    return { total: r.certificates.length, ok: n('ok'), expiring: n('expiring'), expired: n('expired'), failing: n('failing'), issuing: n('issuing') + n('pending'), challenges: r.challenges.length, issuersNotReady: r.issuers.filter(i => !i.ready).length }
}
/** Only what a member limited to some namespaces may see (ClusterIssuers are cluster-wide names only). */
export function limitCerts(r, match) {
    if (!match) return r
    return { ...r, certificates: r.certificates.filter(c => match(c.namespace)), challenges: r.challenges.filter(c => match(c.namespace)), issuers: r.issuers.filter(i => !i.namespace || match(i.namespace)) }
}

const cache = new Map()
const TTL = 30e3
export async function readCerts(cluster, { connect, fresh = false } = {}) {
    const hit = cache.get(cluster.id)
    if (!fresh && hit && Date.now() - hit.at < TTL) return { ...hit.value, cached: true }
    const ssh = await (connect || defaultConnect)(cluster)
    let r
    try { r = await ssh.execCommand(CERT_SCRIPT, { timeoutMs: 120e3 }) } finally { ssh.dispose?.() }
    const out = r?.stdout || ''
    if (!out.includes(`==${MARK}:END==`)) throw Object.assign(new Error(`Could not read the cluster${r?.stderr ? `: ${String(r.stderr).trim().slice(0, 200)}` : ''}`), { status: 502 })
    const value = { ...parseCerts(out), at: new Date().toISOString() }
    cache.set(cluster.id, { at: Date.now(), value })
    return value
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
export const NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
/** The kubectl command that asks cert-manager to issue the certificate again. */
export function renewCommand(namespace, name, { by = 'kubeez', now = new Date() } = {}) {
    if (!NAMESPACE.test(String(namespace)) || !NAME.test(String(name))) throw Object.assign(new Error('Not a valid certificate'), { status: 400 })
    const condition = { type: 'Issuing', status: 'True', reason: 'ManuallyTriggered', message: `Certificate re-issuance manually triggered from KubeEZ by ${String(by).replace(/[^\w.@-]/g, '').slice(0, 60)}`, lastTransitionTime: now.toISOString().replace(/\.\d+Z$/, 'Z') }
    const target = `-n ${q(namespace)} certificates.cert-manager.io ${q(name)} --subresource=status --type=json --request-timeout=30s`
    // add to the conditions; a certificate without any yet gets the list
    return `${KUBECTL} patch ${target} -p ${q(JSON.stringify([{ op: 'add', path: '/status/conditions/-', value: condition }]))} || ${KUBECTL} patch ${target} -p ${q(JSON.stringify([{ op: 'add', path: '/status/conditions', value: [condition] }]))}`
}
export async function renewCert(cluster, cert, { by, connect } = {}) {
    if (cert.state === 'issuing') throw Object.assign(new Error(`${cert.name} is being issued right now — wait for it to finish.`), { status: 409 })
    const ssh = await (connect || defaultConnect)(cluster)
    let r
    try { r = await ssh.execCommand(renewCommand(cert.namespace, cert.name, { by }), { timeoutMs: 70e3 }) } finally { ssh.dispose?.(); cache.delete(cluster.id) }
    if (r?.code) throw Object.assign(new Error(`The cluster refused it: ${String(r.stderr || r.stdout || '').trim().slice(0, 300)}`), { status: 502 })
    return { message: `cert-manager will issue ${cert.namespace}/${cert.name} again now — it takes a minute (longer with ACME).` }
}

// ── alerts: a certificate that fails, expires or comes close (14, 7, 3, 1 days) ──
const sent = new Map()   // "clusterId|ns/name" → what was last alerted
const bucket = (c) => c.state === 'expiring' ? `expiring-${[1, 3, 7, 14].find(d => c.daysLeft < d)}` : c.state
/** One cluster. deps: read(cluster), notify(cluster, ev), usable(orgId) */
export async function alertCluster(cluster, deps) {
    if (!deps.usable(cluster.orgId)) return { skip: 'feature' }
    const r = await deps.read(cluster)
    if (r.tool.state !== 'ok') return { skip: 'no cert-manager' }
    const bad = []
    for (const c of r.certificates) {
        const k = `${cluster.id}|${c.namespace}/${c.name}`
        if (!['expiring', 'expired', 'failing'].includes(c.state)) { sent.delete(k); continue }
        const b = bucket(c)
        if (sent.get(k) === b) continue
        sent.set(k, b); bad.push(c)
    }
    if (bad.length) {
        const worst = bad.some(c => c.state !== 'expiring' || c.daysLeft < 3) ? 'critical' : 'warning'
        deps.notify(cluster, {
            severity: worst, title: `${bad.length} certificate${bad.length === 1 ? '' : 's'} need attention on ${cluster.clusterName}`,
            text: bad.slice(0, 10).map(c => `${c.namespace}/${c.name} (${c.dnsNames.slice(0, 2).join(', ') || c.secretName}): ${c.state === 'expiring' ? `expires in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}` : c.state === 'expired' ? 'EXPIRED' : `failing — ${c.message || c.reason || 'not ready'}`}`).join('\n') + '\nOpen the cluster\'s Certificates tab to see why and renew.'
        })
    }
    return { alerted: bad.length }
}
export const _test = { reset: () => { sent.clear(); cache.clear() }, useConnect(fn) { testConnect = fn; cache.clear() } }

export async function startCertAlerts() {
    const [{ clusterStore }, { features }, { notifier }] = await Promise.all([import('./clusterStore.js'), import('./features.js'), import('./notifier.js')])
    const deps = {
        usable: (orgId) => features.usable(orgId, 'certAlerts') && features.usable(orgId, 'certManager'),
        read: (c) => readCerts(c, { fresh: true }),
        notify: (c, ev) => notifier.emit(c.orgId, { type: 'cert_alert', key: `cert|${c.id}|${ev.title}`, clusterId: c.id, clusterName: c.clusterName, link: `/cluster/${c.id}?tab=certificates`, ...ev })
    }
    const run = async () => {
        for (const c of await clusterStore.getClusters().catch(() => [])) {
            if (c.status === 'failed' && c.mode === 'install') continue
            await alertCluster(c, deps).catch(() => { })
        }
    }
    setTimeout(run, 3 * 60e3).unref?.()
    setInterval(run, 6 * 3600e3).unref?.()
}

let testConnect = null
async function defaultConnect(cluster) {
    if (testConnect) return testConnect(cluster)
    const { connectCluster } = await import('./clusterAccess.js')
    return connectCluster(cluster)
}
