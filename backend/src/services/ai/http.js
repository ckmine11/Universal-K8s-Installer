// Outbound HTTP for AI providers. In SaaS mode a workspace's provider may only
// reach public https addresses (the address actually connected to is checked,
// like alert webhooks). The server's own model (env KUBEEZ_AI_URL) and models
// reached through a cluster tunnel are trusted and skip the check.
import http from 'http'
import https from 'https'
import dns from 'dns'
import net from 'net'
import { isPrivateAddress } from '../../utils/netGuard.js'

export class AiHttpError extends Error {
    constructor(message, { status = null, code = 'HTTP', retryable = false, body = null } = {}) {
        super(message); this.status = status; this.code = code; this.retryable = retryable; this.body = body
    }
}
const saas = () => process.env.KUBEEZ_MODE === 'saas'

function guardedLookup(hostname, opts, cb) {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err)
        const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }]
        if (saas() && list.some(a => isPrivateAddress(a.address))) return cb(new Error(`${hostname} points to a private/internal address — not allowed`))
        if (opts?.all) return cb(null, list)
        cb(null, list[0].address, list[0].family)
    })
}

/** Check a provider address before saving it (same rules as the request itself). */
export function checkProviderUrl(url) {
    let u
    try { u = new URL(url) } catch { throw new AiHttpError('Not a valid address', { code: 'BAD_URL' }) }
    if (!['http:', 'https:'].includes(u.protocol)) throw new AiHttpError('Only http(s) addresses', { code: 'BAD_URL' })
    if (saas() && u.protocol !== 'https:') throw new AiHttpError('Use an https address', { code: 'BAD_URL' })
    const literal = u.hostname.replace(/^\[|\]$/g, '')
    if (saas() && net.isIP(literal) && isPrivateAddress(literal)) throw new AiHttpError(`${literal} is a private/internal address — not allowed here`, { code: 'BAD_URL' })
    return u
}

/**
 * JSON request with a hard timeout. Retryable: timeouts, connection errors, 408/409/429/5xx/529.
 * opts.createConnection — send through a given stream (cluster tunnel); opts.trusted — skip the address check.
 */
export function requestJson(method, url, body, { headers = {}, timeoutMs = 60000, createConnection = null, trusted = false, maxBytes = 4 << 20 } = {}) {
    return new Promise((resolve, reject) => {
        let u
        try { u = trusted || createConnection ? new URL(url) : checkProviderUrl(url) } catch (e) { return reject(e instanceof AiHttpError ? e : new AiHttpError(e.message, { code: 'BAD_URL' })) }
        const data = body === undefined ? '' : JSON.stringify(body)
        const lib = u.protocol === 'https:' && !createConnection ? https : http
        const req = lib.request(u, {
            method,
            ...(createConnection ? { createConnection } : trusted ? {} : { lookup: guardedLookup }),
            headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), accept: 'application/json', 'user-agent': 'KubeEZ-AI/1', ...headers }
        }, (res) => {
            let size = 0; const chunks = []
            res.on('data', c => { size += c.length; if (size <= maxBytes) chunks.push(c) })
            res.on('end', () => {
                clearTimeout(timer)
                const text = Buffer.concat(chunks).toString('utf8')
                let json = null; try { json = text ? JSON.parse(text) : null } catch { }
                if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json ?? {})
                const msg = json?.error?.message || json?.error || json?.message || text.slice(0, 300) || `HTTP ${res.statusCode}`
                const retryable = [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(res.statusCode)
                reject(new AiHttpError(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300), { status: res.statusCode, retryable, body: text.slice(0, 2000) }))
            })
        })
        const timer = setTimeout(() => { req.destroy(new AiHttpError(`No answer within ${Math.round(timeoutMs / 1000)} s`, { code: 'TIMEOUT', retryable: true })) }, timeoutMs)
        req.on('error', (e) => { clearTimeout(timer); reject(e instanceof AiHttpError ? e : new AiHttpError(e.message, { code: 'NETWORK', retryable: true })) })
        if (data) req.write(data)
        req.end()
    })
}

/**
 * A streamed answer (Server-Sent Events, the OpenAI format): onDelta(text) for every
 * piece as the model writes it. → { text, model, usage } when it is done.
 * Same rules as requestJson: address check, tunnel, a hard timeout (from the first
 * byte on, a quiet stream also times out).
 */
export function requestStream(url, body, { headers = {}, timeoutMs = 60000, createConnection = null, trusted = false, onDelta = () => { } } = {}) {
    return new Promise((resolve, reject) => {
        let u
        try { u = trusted || createConnection ? new URL(url) : checkProviderUrl(url) } catch (e) { return reject(e instanceof AiHttpError ? e : new AiHttpError(e.message, { code: 'BAD_URL' })) }
        const data = JSON.stringify(body)
        const lib = u.protocol === 'https:' && !createConnection ? https : http
        let timer
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => req.destroy(new AiHttpError(`No answer within ${Math.round(timeoutMs / 1000)} s`, { code: 'TIMEOUT', retryable: true })), timeoutMs) }
        const req = lib.request(u, {
            method: 'POST',
            ...(createConnection ? { createConnection } : trusted ? {} : { lookup: guardedLookup }),
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'text/event-stream', 'user-agent': 'KubeEZ-AI/1', ...headers }
        }, (res) => {
            // an error comes back as plain JSON, not as a stream
            if (res.statusCode < 200 || res.statusCode >= 300) {
                const chunks = []
                res.on('data', c => chunks.push(c))
                res.on('end', () => {
                    clearTimeout(timer)
                    const t = Buffer.concat(chunks).toString('utf8')
                    let j = null; try { j = JSON.parse(t) } catch { }
                    const msg = j?.error?.message || j?.error || j?.message || t.slice(0, 300) || `HTTP ${res.statusCode}`
                    reject(new AiHttpError(typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300), { status: res.statusCode, retryable: [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(res.statusCode), body: t.slice(0, 2000) }))
                })
                return
            }
            let buf = '', text = '', model = null, usage = null, failed = null
            res.setEncoding('utf8')
            res.on('data', (c) => {
                arm()
                buf += c
                let i
                while ((i = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
                    if (!line.startsWith('data:')) continue
                    const payload = line.slice(5).trim()
                    if (payload === '[DONE]') continue
                    let j; try { j = JSON.parse(payload) } catch { continue }
                    if (j.error) { failed = new AiHttpError(typeof j.error === 'string' ? j.error : j.error.message || 'The model stopped with an error', { code: 'HTTP', retryable: true }); continue }
                    if (j.model) model = j.model
                    if (j.usage) usage = j.usage
                    const d = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? ''
                    if (d) { text += d; try { onDelta(d, text) } catch { } }
                }
            })
            res.on('end', () => {
                clearTimeout(timer)
                if (failed && !text) return reject(failed)
                resolve({ text, model, usage })
            })
            res.on('error', (e) => { clearTimeout(timer); reject(new AiHttpError(e.message, { code: 'NETWORK', retryable: true })) })
        })
        arm()
        req.on('error', (e) => { clearTimeout(timer); reject(e instanceof AiHttpError ? e : new AiHttpError(e.message, { code: 'NETWORK', retryable: true })) })
        req.write(data)
        req.end()
    })
}
