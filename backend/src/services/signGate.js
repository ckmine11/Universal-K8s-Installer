import crypto from 'crypto'
import { assertDirectConnectAllowed } from '../utils/netGuard.js'

// Image signature gate (cosign, key-based): before an app is deployed into an
// environment with a signature policy, every image it will run must carry a
// cosign signature made with one of the workspace's public keys.
//
// KubeEZ checks it itself, like `cosign verify --key k.pub --insecure-ignore-tlog`:
// the image's digest → the signature manifest (tag sha256-<digest>.sig) → each
// signature layer's payload names that digest and its signature verifies with
// a trusted key. No transparency log (Rekor) and no keyless (Fulcio) signing.
//   warn   deploy with a warning listing what is unsigned
//   block  stop the deploy (an admin may deploy anyway with a reason); an image
//          that cannot be checked (registry unreachable) counts as unsigned
const SIG_ANNOTATION = 'dev.cosignproject.cosign/signature'
const MANIFEST_TYPES = [
    'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'
].join(', ')
const MAX_BODY = 1024 * 1024
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

/** "nginx:1.25", "ghcr.io/acme/web@sha256:…" → { registry, apiHost, repo, tag, digest } */
export function parseImage(ref) {
    let s = String(ref || '').trim()
    if (!s || s.length > 500 || /\s/.test(s)) throw bad(`Not an image reference: ${String(ref).slice(0, 80)}`)
    let digest = null
    const at = s.indexOf('@')
    if (at >= 0) { digest = s.slice(at + 1); s = s.slice(0, at); if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw bad(`Not a valid digest in ${ref}`) }
    const parts = s.split('/')
    let registry = 'docker.io'
    if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) registry = parts.shift()
    let last = parts.pop(), tag = null
    const colon = last.lastIndexOf(':')
    if (colon > 0) { tag = last.slice(colon + 1); last = last.slice(0, colon) }
    parts.push(last)
    let repo = parts.join('/')
    if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(registry)) { registry = 'docker.io'; if (!repo.includes('/')) repo = `library/${repo}` }
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(repo)) throw bad(`Not a valid repository in ${ref}`)
    if (tag && !/^[\w][\w.-]{0,127}$/.test(tag)) throw bad(`Not a valid tag in ${ref}`)
    return { registry, apiHost: registry === 'docker.io' ? 'registry-1.docker.io' : registry, repo, tag: digest ? tag : tag || 'latest', digest }
}

/** A PEM public key → { pem, fingerprint, type } (EC or RSA), or 400. */
export function cleanPublicKey(pem) {
    const s = String(pem || '').trim()
    if (s.length > 10000 || !/^-----BEGIN (PUBLIC KEY|EC PUBLIC KEY|RSA PUBLIC KEY)-----/.test(s)) throw bad('Paste a PEM public key (cosign.pub: -----BEGIN PUBLIC KEY-----)')
    let k
    try { k = crypto.createPublicKey(s) } catch { throw bad('That is not a valid public key') }
    if (!['ec', 'rsa', 'ed25519'].includes(k.asymmetricKeyType)) throw bad('Use an ECDSA, RSA or Ed25519 public key')
    const der = k.export({ type: 'spki', format: 'der' })
    return { pem: k.export({ type: 'spki', format: 'pem' }).toString().trim(), fingerprint: crypto.createHash('sha256').update(der).digest('hex').slice(0, 16), type: k.asymmetricKeyType }
}

// ── the registry API (anonymous or with the workspace's registry login) ──
const tokens = new Map()   // "host|scope|user" → { token, until }
function challenge(h) {
    const m = /^(\w+)\s+(.*)$/.exec(String(h || ''))
    if (!m) return null
    const params = {}
    for (const p of m[2].matchAll(/(\w+)="([^"]*)"/g)) params[p[1]] = p[2]
    return { scheme: m[1].toLowerCase(), ...params }
}
async function readCapped(r) {
    const len = Number(r.headers.get('content-length') || 0)
    if (len > MAX_BODY) throw bad('The registry answered with too much data', 502)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_BODY) throw bad('The registry answered with too much data', 502)
    return buf
}
// GET with redirects checked one by one (blob downloads go to a CDN) — never to a private address in SaaS
async function get(fetchImpl, url, headers) {
    for (let i = 0; i < 4; i++) {
        const u = new URL(url)
        if (u.protocol !== 'https:') throw bad(`The registry sent KubeEZ to a non-https address (${u.host})`, 502)
        await assertDirectConnectAllowed(u.hostname)
        const r = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(20000) })
        if (![301, 302, 303, 307, 308].includes(r.status)) return r
        url = new URL(r.headers.get('location'), url).toString()
        headers = { Accept: headers.Accept }   // credentials stay with the registry
    }
    throw bad('Too many redirects from the registry', 502)
}
async function registryGet(img, path, { accept, creds, fetchImpl }) {
    const url = `https://${img.apiHost}/v2/${img.repo}/${path}`
    const scope = `repository:${img.repo}:pull`
    const key = `${img.apiHost}|${scope}|${creds?.username || ''}`
    const basic = creds?.username ? `Basic ${Buffer.from(`${creds.username}:${creds.password || ''}`).toString('base64')}` : null
    const cached = tokens.get(key)
    const auth = cached && cached.until > Date.now() ? `Bearer ${cached.token}` : null
    let r = await get(fetchImpl, url, { Accept: accept, ...(auth ? { Authorization: auth } : {}) })
    if (r.status === 401) {
        const c = challenge(r.headers.get('www-authenticate'))
        let header = null
        if (c?.scheme === 'bearer' && c.realm) {
            const t = new URL(c.realm)
            if (c.service) t.searchParams.set('service', c.service)
            t.searchParams.set('scope', c.scope || scope)
            const tr = await get(fetchImpl, t.toString(), { Accept: 'application/json', ...(basic ? { Authorization: basic } : {}) })
            if (!tr.ok) throw bad(`The registry refused a token (${tr.status})${basic ? ' — check the registry login in Delivery → Registries' : ''}`, 502)
            const d = JSON.parse((await readCapped(tr)).toString('utf8') || '{}')
            const token = d.token || d.access_token
            if (!token) throw bad('The registry gave no token', 502)
            tokens.set(key, { token, until: Date.now() + Math.min(Number(d.expires_in) || 60, 300) * 1000 })
            header = `Bearer ${token}`
        } else if (c?.scheme === 'basic' && basic) header = basic
        if (!header) throw bad(`The registry ${img.registry} needs a login — add it in Delivery → Registries`, 502)
        r = await get(fetchImpl, url, { Accept: accept, Authorization: header })
    }
    return r
}

/** Is this image signed by one of the keys? → { image, status: signed | unsigned | invalid | error, key?, digest?, message? } */
export async function verifyImage(image, keys, { credsFor = () => null, fetchImpl = fetch } = {}) {
    let img
    try { img = parseImage(image) } catch (e) { return { image, status: 'error', message: e.message } }
    const opts = { creds: credsFor(img.registry), fetchImpl }
    try {
        let digest = img.digest
        if (!digest) {
            const r = await registryGet(img, `manifests/${img.tag}`, { ...opts, accept: MANIFEST_TYPES })
            if (r.status === 404) return { image, status: 'error', message: `${img.repo}:${img.tag} was not found in ${img.registry}` }
            if (!r.ok) return { image, status: 'error', message: `The registry answered ${r.status}` }
            const body = await readCapped(r)
            digest = r.headers.get('docker-content-digest') || `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`
        }
        const sig = await registryGet(img, `manifests/${digest.replace(':', '-')}.sig`, { ...opts, accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' })
        if (sig.status === 404) return { image, status: 'unsigned', digest, message: 'no cosign signature' }
        if (!sig.ok) return { image, status: 'error', digest, message: `The registry answered ${sig.status} for the signature` }
        const manifest = JSON.parse((await readCapped(sig)).toString('utf8'))
        const layers = (manifest.layers || []).filter(l => l.annotations?.[SIG_ANNOTATION]).slice(0, 10)
        if (!layers.length) return { image, status: 'unsigned', digest, message: 'no cosign signature' }
        const trusted = keys.map(k => { try { return { name: k.name, key: crypto.createPublicKey(k.pem) } } catch { return null } }).filter(Boolean)
        for (const l of layers) {
            if (!/^sha256:[0-9a-f]{64}$/.test(l.digest || '')) continue
            const b = await registryGet(img, `blobs/${l.digest}`, { ...opts, accept: '*/*' })
            if (!b.ok) continue
            const payload = await readCapped(b)
            if (`sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` !== l.digest) continue
            let claim
            try { claim = JSON.parse(payload.toString('utf8')) } catch { continue }
            if (claim?.critical?.image?.['docker-manifest-digest'] !== digest) continue
            const signature = Buffer.from(l.annotations[SIG_ANNOTATION], 'base64')
            for (const t of trusted) {
                let ok = false
                try { ok = crypto.verify(t.key.asymmetricKeyType === 'ed25519' ? null : 'sha256', payload, t.key, signature) } catch { ok = false }
                if (ok) return { image, status: 'signed', key: t.name, digest }
            }
        }
        return { image, status: 'invalid', digest, message: 'signed, but not with a key this workspace trusts' }
    } catch (e) {
        return { image, status: 'error', message: e.message.slice(0, 200) }
    }
}

/**
 * The images of a deploy under a policy → { mode, blocked, signed: [{ image, key }], failing: [{ image, status, message }] }
 * keys: [{ name, pem }]; no keys at all fails every image (nothing can be trusted).
 */
export async function checkSignatures(images, policy, { keys = [], credsFor, fetchImpl } = {}) {
    const results = await Promise.all(images.slice(0, 30).map(i => keys.length ? verifyImage(i, keys, { credsFor, fetchImpl }) : { image: i, status: 'unsigned', message: 'no signing keys in this workspace (Delivery → Signing keys)' }))
    const signed = results.filter(r => r.status === 'signed').map(r => ({ image: r.image, key: r.key }))
    const failing = results.filter(r => r.status !== 'signed').map(r => ({ image: r.image, status: r.status, message: r.message || null }))
    return { mode: policy?.mode || 'off', blocked: policy?.mode === 'block' && failing.length > 0, signed, failing }
}

/** One line for errors and the audit trail. */
export const signText = (s) => s.failing.map(f => `${f.image} (${f.status === 'invalid' ? 'untrusted signature' : f.status === 'error' ? `not checked: ${f.message}` : 'unsigned'})`).join('; ')

/**
 * The signature gate of an environment for a deploy, or null (no policy / feature off).
 * override: an admin's reason to deploy past "block".
 */
export async function signGateFor(orgId, env, override = null) {
    if (!env?.signPolicy) return null
    const [{ features }, { deliveryStore }] = await Promise.all([import('./features.js'), import('./deliveryStore.js')])
    if (!features.usable(orgId, 'signGate')) return null
    const regs = deliveryStore.registries(orgId)
    const credsFor = (registry) => {
        const r = regs.find(x => x.server === registry || (registry === 'docker.io' && ['index.docker.io', 'registry-1.docker.io'].includes(x.server)))
        return r ? deliveryStore.registryCredentials(orgId, r.id) : null
    }
    return { policy: env.signPolicy, override: override || null, keys: deliveryStore.signingKeys(orgId), credsFor }
}

export const _test = { reset: () => tokens.clear() }
