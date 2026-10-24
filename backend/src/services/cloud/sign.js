// How each cloud wants its API requests signed — no SDKs, Node's crypto only.
//   aws     Signature Version 4 (EKS)
//   google  a service-account JWT exchanged for an access token (GKE)
//   oci     the OCI HTTP signature (OKE)
// (Azure, DigitalOcean and Linode use a bearer token — see providers.js.)
import crypto from 'crypto'

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

// RFC 3986 encoding, as SigV4 wants it
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/**
 * AWS Signature Version 4 → the headers to send.
 * req: { method, url, headers?, body? }; creds: { accessKeyId, secretAccessKey, sessionToken? }
 */
export function sigv4(req, creds, { region, service, now = new Date() }) {
    const u = new URL(req.url)
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')   // 20150830T123600Z
    const day = amzDate.slice(0, 8)
    const body = req.body || ''
    const headers = { ...(req.headers || {}), host: u.host, 'x-amz-date': amzDate, ...(creds.sessionToken ? { 'x-amz-security-token': creds.sessionToken } : {}) }
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]))
    const names = Object.keys(lower).sort()
    const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('&')
    const canonicalPath = u.pathname.split('/').map(p => enc(decodeURIComponent(p))).join('/') || '/'
    const canonical = [req.method.toUpperCase(), canonicalPath, canonicalQuery, names.map(n => `${n}:${lower[n]}\n`).join(''), names.join(';'), sha256hex(body)].join('\n')
    const scope = `${day}/${region}/${service}/aws4_request`
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), 'aws4_request')
    const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex')
    return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`, _canonical: canonical, _signature: signature }
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** A Google service account's signed JWT (RS256) for the token endpoint. */
export function googleJwt(sa, { scope = 'https://www.googleapis.com/auth/cloud-platform', now = Date.now() } = {}) {
    const iat = Math.floor(now / 1000)
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }))
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }))
    const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key)
    return `${head}.${claims}.${b64url(sig)}`
}

/**
 * The OCI request signature → the headers to send.
 * creds: { tenancy, user, fingerprint, privateKey }
 */
export function ociSign(req, creds, { now = new Date() } = {}) {
    const u = new URL(req.url)
    const method = req.method.toLowerCase()
    const body = req.body || ''
    const headers = { ...(req.headers || {}), date: now.toUTCString(), host: u.host }
    const names = ['date', '(request-target)', 'host']
    if (['post', 'put', 'patch'].includes(method)) {
        headers['content-type'] ||= 'application/json'
        headers['content-length'] = String(Buffer.byteLength(body))
        headers['x-content-sha256'] = crypto.createHash('sha256').update(body).digest('base64')
        names.push('content-length', 'content-type', 'x-content-sha256')
    }
    const line = (n) => n === '(request-target)' ? `(request-target): ${method} ${u.pathname}${u.search}` : `${n}: ${headers[n]}`
    const signingString = names.map(line).join('\n')
    const signature = crypto.createSign('RSA-SHA256').update(signingString).sign(creds.privateKey, 'base64')
    return { ...headers, authorization: `Signature version="1",keyId="${creds.tenancy}/${creds.user}/${creds.fingerprint}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`, _signingString: signingString }
}
