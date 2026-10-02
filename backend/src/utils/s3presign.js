import crypto from 'crypto'

// AWS Signature V4 presigned URLs (query-string auth) for S3 and every
// S3-compatible store (MinIO, Cloudflare R2, Wasabi, Backblaze B2, …).
// The backend signs; the node only runs plain `curl` against the URL — so the
// node needs no SigV4 support and never sees the access/secret keys.

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest()

// RFC 3986 encoding as required by SigV4 (encodeURIComponent leaves !'()* alone)
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const encPath = (p) => p.split('/').map(enc).join('/')

/**
 * Where a bucket/key lives for a target.
 * AWS: virtual-hosted style (bucket.s3.<region>.amazonaws.com) unless the
 * bucket name has dots (TLS wildcard) → path style. Others: path style.
 */
export function objectLocation(target, key = '') {
    const ep = new URL(target.endpoint)
    const virtual = target.provider === 'aws' && !target.bucket.includes('.')
    const host = virtual ? `${target.bucket}.${ep.host}` : ep.host
    const path = virtual ? `/${key}` : `/${target.bucket}${key ? '/' + key : '/'}`
    return { protocol: ep.protocol, host, path }
}

/**
 * Presign one request.
 *   method  GET | PUT | DELETE
 *   key     object key ('' for bucket-level requests like ListObjectsV2)
 *   query   extra query params (e.g. { 'list-type': '2', prefix: 'a/' })
 */
export function presign(target, { method, key = '', query = {}, expires = 3600, now = new Date() }) {
    const region = target.region || 'us-east-1'
    const { protocol, host, path } = objectLocation(target, key)
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')   // YYYYMMDDTHHMMSSZ
    const day = amzDate.slice(0, 8)
    const scope = `${day}/${region}/s3/aws4_request`

    const params = {
        ...query,
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${target.accessKey}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(expires),
        'X-Amz-SignedHeaders': 'host'
    }
    const canonicalQuery = Object.keys(params).sort()
        .map(k => `${enc(k)}=${enc(params[k])}`).join('&')
    const canonicalUri = encPath(path)

    const canonicalRequest = [
        method, canonicalUri, canonicalQuery,
        `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'
    ].join('\n')
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')

    const kDate = hmac('AWS4' + target.secretKey, day)
    const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request')
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

    return `${protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
