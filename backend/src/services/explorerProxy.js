import http from 'http'
import crypto from 'crypto'
import { clusterTunnel } from './clusterTunnel.js'
import { automationEngine } from './automationEngine.js'
import { installationManager } from './installationManager.js'
import { authService } from './authService.js'
import { canAccessResource } from '../utils/access.js'

/**
 * KubeEZ Explorer (Radar, Apache-2.0) behind KubeEZ.
 *
 * Radar runs in the cluster with auth.mode=proxy behind a ClusterIP Service.
 * KubeEZ is its ONLY way in: this proxy authenticates the KubeEZ user, checks
 * the workspace owns the cluster, removes any identity headers the browser
 * sent, adds the real ones (user + role group) and carries the request through
 * the cluster tunnel (SSH / Gateway Agent). Radar then acts as that user, so
 * Kubernetes RBAC (explorer.sh maps the groups) decides what is allowed.
 */
export const EXPLORER_NS = 'kubeez-explorer'
// Service name; installs from before the KubeEZ rename still have "radar"
const SVCS = ['kubeez-explorer', 'radar']
const PORT = 9280
export const basePath = (clusterId) => `/api/clusters/${clusterId}/explorer`
// Lookahead, not a consumed "/": an Express mount must end on a path boundary
export const EXPLORER_PATH = /^\/api\/clusters\/([A-Za-z0-9-]+)\/explorer(?=[/?]|$)/

const KB = 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl'
const TARGET_TTL = 60 * 1000
const targets = new Map()   // clusterId → { ip, at }

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate'])
const ROLE_GROUP = { superadmin: 'kubeez:admins', admin: 'kubeez:admins', operator: 'kubeez:operators' }

/** The identity Radar (and Kubernetes RBAC) sees for a KubeEZ user. */
export function identityFor(user) {
    const clean = (s) => String(s || '').replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 100)
    return {
        user: `kubeez:${clean(user.username || user.id)}`,
        groups: [ROLE_GROUP[user.role] || 'kubeez:viewers', `kubeez:org:${clean(user.orgId || 'none')}`]
    }
}

/** Request headers for Radar: no KubeEZ credentials, no client-supplied identity. */
export function upstreamHeaders(reqHeaders, user, { keepUpgrade = false, proto = 'http' } = {}) {
    const out = {}
    for (const [k, v] of Object.entries(reqHeaders)) {
        const key = k.toLowerCase()
        if (key === 'authorization' || key.startsWith('x-forwarded-') || key === 'x-real-ip' || key === 'forwarded') continue
        if (!keepUpgrade && HOP.has(key)) continue
        // No cookies at all: Radar trusts its own session cookie BEFORE the
        // identity headers, so a cookie left by an earlier KubeEZ user in the
        // same browser would act as that user. The headers below are the only
        // identity Radar ever gets (and KubeEZ's token never leaves KubeEZ).
        if (key === 'cookie') continue
        out[key] = v
    }
    const id = identityFor(user)
    out['x-forwarded-user'] = id.user
    out['x-forwarded-groups'] = id.groups.join(',')
    out['x-forwarded-proto'] = proto
    if (reqHeaders.host) out['x-forwarded-host'] = reqHeaders.host
    return out
}

// ── KubeEZ branding for the Explorer UI ──────────────────────────────────────
// The engine (Radar, Apache-2.0) is used unmodified; its pages get KubeEZ's
// name, logo and title here. Engine links (GitHub, its cloud offer, release
// notes) are hidden. Credit for the engine stays in THIRD_PARTY_NOTICES.md.
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2563eb"/><rect x="8" y="8" width="16" height="6" rx="1.5" fill="none" stroke="#fff" stroke-width="2"/><rect x="8" y="18" width="16" height="6" rx="1.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="11.5" cy="11" r="1" fill="#fff"/><circle cx="11.5" cy="21" r="1" fill="#fff"/></svg>'
export const EXPLORER_LOGO = 'data:image/svg+xml,' + encodeURIComponent(LOGO_SVG)
const BRAND_CSS = `[aria-label="Radar Cloud"],[aria-label*="Radar on GitHub"],a[href*="github.com/skyhook-io"],a[href*="radarhq.io"]{display:none!important}`
// Runs in the page: renames the engine's texts, swaps its logo, keeps the
// tab title on KubeEZ — again whenever the app re-renders.
const BRAND_JS = `(function(){
var L=${JSON.stringify(EXPLORER_LOGO)};
function t(){var d=document.title;if(/Radar/.test(d))document.title=d.replace(/ · Radar$/,' · KubeEZ Explorer').replace(/^Radar$/,'KubeEZ Explorer');}
function fix(root){
 if(!root||!root.querySelectorAll)return;
 var w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),n;
 while((n=w.nextNode())){var v=n.nodeValue,s=v.trim();
  if(s==='Radar')n.nodeValue=v.replace('Radar','KubeEZ');
  else if(/^by Skyhook$/i.test(s))n.nodeValue=v.replace(/by Skyhook/i,'Explorer');
  else if(/^· by Skyhook$/i.test(s))n.nodeValue=v.replace(/· by Skyhook/i,'· KubeEZ Explorer');
  else if(s==="What's new"){var b=n.parentElement&&n.parentElement.closest('button,a,li');if(b)b.style.display='none';}}
 root.querySelectorAll('img').forEach(function(i){if(/radar/i.test(i.getAttribute('src')||'')&&i.src!==L)i.src=L;});}
var q=false;function run(){q=false;fix(document.body);t();}
new MutationObserver(function(){if(!q){q=true;requestAnimationFrame(run);}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
document.addEventListener('DOMContentLoaded',run);t();
})();`

/** An Explorer page with KubeEZ's title, icon and branding script. */
export function brandPage(html) {
    if (!/<head[\s>]/i.test(html)) return html
    let out = html
        .replace(/<title>[^<]*<\/title>/i, '<title>KubeEZ Explorer</title>')
        .replace(/<link[^>]+rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>\s*/gi, '')
    const title = /<title>/i.test(out) ? '' : '<title>KubeEZ Explorer</title>'
    const inject = `${title}<link rel="icon" type="image/svg+xml" href="${EXPLORER_LOGO}"><style>${BRAND_CSS}</style><script>${BRAND_JS}</script>`
    return out.replace(/<\/head>/i, inject + '</head>')
}

/** Strict CSP for an Explorer page: Radar's own inline scripts allowed by hash only. */
export function cspFor(html) {
    const hashes = []
    const re = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = re.exec(html))) {
        if (m[1].trim()) hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`)
    }
    return [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(' ')}`.trim(),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "frame-ancestors 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    ].join('; ')
}

async function findCluster(user, clusterId) {
    const clusters = await installationManager.getSavedClusters()
    const cluster = clusters.find(c => c.id === clusterId)
    if (!cluster) throw Object.assign(new Error('Cluster not found'), { status: 404 })
    if (!canAccessResource(user, cluster)) throw Object.assign(new Error('Unauthorized access to this cluster'), { status: 403 })
    return cluster
}

async function target(cluster, fresh = false) {
    const t = targets.get(cluster.id)
    if (t && !fresh && Date.now() - t.at < TARGET_TTL) return t.ip
    const ssh = await automationEngine.connectSSH({ ...cluster.masterNodes[0], ownerId: cluster.ownerId, orgId: cluster.orgId })
    try {
        const r = await ssh.execCommand(SVCS.map(n => `${KB} -n ${EXPLORER_NS} get svc ${n} -o jsonpath='{.spec.clusterIP}' 2>/dev/null`).join(' || '))
        const ip = (r.stdout || '').trim()
        if (!/^[0-9a-f.:]+$/i.test(ip)) {
            targets.delete(cluster.id)
            throw Object.assign(new Error('The KubeEZ Explorer is not installed on this cluster — install it from Add-ons.'), { status: 404, code: 'NOT_INSTALLED' })
        }
        targets.set(cluster.id, { ip, at: Date.now() })
        if (!gateChecked.has(cluster.id)) {
            // Explorers installed before the Helm gate existed get it here, so
            // Helm installs work without a manual Repair (same YAML as explorer.sh)
            const b64 = Buffer.from(HELM_GATE_YAML).toString('base64')
            const g = await ssh.execCommand(`${KB} get clusterrolebinding kubeez-explorer-helm-gate >/dev/null 2>&1 || (echo ${b64} | base64 -d | ${KB} apply -f - >/dev/null)`)
            if (g.code === 0) gateChecked.add(cluster.id)
        }
        return ip
    } finally {
        ssh.dispose?.()
    }
}

// Radar 1.15 opens Helm writes only when its service account may create
// Secrets; installs then run as the signed-in user (see explorer.sh)
const gateChecked = new Set()
const HELM_GATE_YAML = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kubeez-explorer-helm-gate
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kubeez-explorer-helm-gate
  labels: { app.kubernetes.io/part-of: kubeez-explorer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kubeez-explorer-helm-gate }
subjects:
  - { kind: ServiceAccount, name: kubeez-explorer, namespace: ${EXPLORER_NS} }
  - { kind: ServiceAccount, name: radar, namespace: ${EXPLORER_NS} }
`

async function openUpstream(cluster) {
    const ip = await target(cluster)
    try {
        return await clusterTunnel.open(cluster, ip, PORT)
    } catch (e) {
        if (e.code === 'AGENT_OUTDATED') throw Object.assign(e, { status: 502 })
        // the Service may have been recreated with a new IP
        const again = await target(cluster, true)
        return clusterTunnel.open(cluster, again, PORT)
    }
}

const sendError = (res, status, message, code) => {
    if (res.headersSent) { try { res.destroy() } catch { } return }
    res.status(status).json({ error: message, code })
}

/** Express handler (after requireAuth) for /api/clusters/:id/explorer/** */
export async function explorerHttp(req, res) {
    // Radar has no CSRF protection of its own in proxy mode: changes (scale,
    // delete, apply…) are accepted only from KubeEZ's own pages. The session
    // cookie is SameSite=strict as well — this is the second lock.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
        let same = false
        try { same = new URL(req.headers.origin).host === req.headers.host } catch { }
        const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
        if (!same && !allowed.includes(req.headers.origin)) return sendError(res, 403, 'Cross-site request refused')
    }
    const id = req.originalUrl.match(EXPLORER_PATH)?.[1]
    let cluster
    try {
        cluster = await findCluster(req.user, id)
    } catch (e) { return sendError(res, e.status || 500, e.message) }

    let stream
    try {
        stream = await openUpstream(cluster)
    } catch (e) {
        return sendError(res, e.status || 502, e.status ? e.message : `Could not reach the KubeEZ Explorer: ${e.message}`, e.code)
    }

    const headers = upstreamHeaders(req.headers, req.user, { proto: req.protocol })
    // Pages come back uncompressed so their inline scripts can be hashed for the CSP
    const wantsPage = String(req.headers.accept || '').includes('text/html')
    if (wantsPage) delete headers['accept-encoding']
    headers.connection = 'close'

    const up = http.request({ method: req.method, path: req.originalUrl, headers, createConnection: () => stream })
    up.on('response', (pres) => {
        const h = { ...pres.headers }
        delete h['content-security-policy']
        delete h['x-frame-options']
        delete h['set-cookie']   // see upstreamHeaders: Radar sessions are never used
        h['x-frame-options'] = 'SAMEORIGIN'
        h['x-content-type-options'] = 'nosniff'
        const isHtml = /text\/html/i.test(h['content-type'] || '')
        if (!isHtml || h['content-encoding']) {
            if (isHtml) h['content-security-policy'] = cspFor('')
            res.writeHead(pres.statusCode, h)
            pres.pipe(res)
            return
        }
        const chunks = []
        pres.on('data', c => chunks.push(c))
        pres.on('end', () => {
            const html = brandPage(Buffer.concat(chunks).toString('utf8'))
            const body = Buffer.from(html, 'utf8')
            h['content-security-policy'] = cspFor(html)
            h['content-length'] = String(body.length)
            delete h['transfer-encoding']
            res.writeHead(pres.statusCode, h)
            res.end(body)
        })
    })
    up.on('error', (e) => sendError(res, 502, `The KubeEZ Explorer connection failed: ${e.message}`))
    // browser gone (closed tab, ended SSE) → close the tunnel stream too
    res.on('close', () => { try { up.destroy() } catch { } try { stream.destroy() } catch { } })
    req.pipe(up)
}

function parseCookies(header) {
    return Object.fromEntries(String(header || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]))
}

/**
 * WebSocket upgrades (pod terminal, log streams). Called from the HTTP
 * server's 'upgrade' event for Explorer paths. Origin must be our own site.
 */
export async function explorerUpgrade(req, socket, head, allowedOrigins = []) {
    const reject = (code, msg) => { try { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`) } catch { } }
    const origin = req.headers.origin
    if (origin) {
        let same = false
        try { same = new URL(origin).host === req.headers.host } catch { }
        if (!same && !allowedOrigins.includes(origin)) return reject(403, 'Forbidden')
    }
    const token = parseCookies(req.headers.cookie).token || (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
    const user = token ? authService.verifyToken(token) : null
    if (!user) return reject(401, 'Unauthorized')

    const id = req.url.match(EXPLORER_PATH)?.[1]
    let cluster, stream
    try {
        cluster = await findCluster(user, id)
        stream = await openUpstream(cluster)
    } catch (e) {
        return reject(e.status === 403 ? 403 : e.status === 404 ? 404 : 502, e.status === 403 ? 'Forbidden' : 'Bad Gateway')
    }
    const headers = upstreamHeaders(req.headers, user, { keepUpgrade: true, proto: req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http' })
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(headers)) {
        for (const val of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(val).replace(/[\r\n]/g, '')}`)
    }
    stream.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) stream.write(head)
    const end = () => { try { socket.destroy() } catch { } try { stream.destroy() } catch { } }
    stream.on('error', end); socket.on('error', end)
    stream.on('close', end); socket.on('close', end)
    stream.pipe(socket)
    socket.pipe(stream)
}

/**
 * Call Radar's HTTP API for KubeEZ's own screens (upgrade readiness, audit),
 * as the signed-in user. Resolves to parsed JSON.
 */
export async function explorerApi(cluster, user, apiPath, { timeoutMs = 60000 } = {}) {
    const stream = await openUpstream(cluster)
    const headers = upstreamHeaders({ host: 'kubeez-internal', accept: 'application/json' }, user)
    headers.connection = 'close'
    return new Promise((resolve, reject) => {
        // Own timer: tunnel streams (SSH channel, agent relay) have no
        // socket.setTimeout, so request.setTimeout() would throw
        let timer
        const done = (fn, v) => { clearTimeout(timer); fn(v) }
        const up = http.request({ method: 'GET', path: `${basePath(cluster.id)}${apiPath}`, headers, createConnection: () => stream }, (pres) => {
            const chunks = []
            pres.on('data', c => chunks.push(c))
            pres.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                if (pres.statusCode >= 400) return done(reject, Object.assign(new Error(`Explorer answered ${pres.statusCode}: ${text.slice(0, 200)}`), { status: pres.statusCode }))
                try { done(resolve, JSON.parse(text)) } catch { done(reject, new Error('The Explorer returned no JSON')) }
            })
        })
        timer = setTimeout(() => { up.destroy(new Error('The Explorer did not answer in time')); try { stream.destroy() } catch { } }, timeoutMs)
        up.on('error', (e) => done(reject, e))
        up.end()
    })
}

export { findCluster as findExplorerCluster }
