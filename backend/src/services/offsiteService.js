import { automationEngine } from './automationEngine.js'
import { etcdBackupService, ETCD_RETENTION_DAYS } from './etcdBackupService.js'
import { PROVIDERS } from './offsiteStore.js'
import { presign } from '../utils/s3presign.js'

const NODE_TOOL = '/usr/local/sbin/kubeez-etcd-offsite'
const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64')

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/
const PREFIX_RE = /^[a-zA-Z0-9/_.-]{0,100}$/

/**
 * Validate + normalise what the user typed. Throws an Error with a message
 * meant for the user. `existing` supplies keys when the user left them blank
 * ("keep current") while editing a connection.
 */
export function normaliseConfig(input = {}, existing = null) {
    const provider = String(input.provider || '').toLowerCase()
    if (!PROVIDERS.includes(provider)) throw new Error('Choose AWS S3, MinIO or another S3-compatible storage.')

    const bucket = String(input.bucket || '').trim()
    if (!BUCKET_RE.test(bucket) || bucket.includes('..')) {
        throw new Error('Bucket name must be 3–63 characters: lowercase letters, numbers, dots and hyphens.')
    }

    let endpoint, region = ''
    if (provider === 'aws') {
        region = String(input.region || '').trim()
        if (!REGION_RE.test(region)) throw new Error('Choose a valid AWS region (e.g. ap-south-1).')
        endpoint = `https://s3.${region}.amazonaws.com`
    } else {
        let url
        try { url = new URL(String(input.endpoint || '').trim()) } catch { throw new Error('Enter the storage endpoint as a URL, e.g. https://minio.example.com:9000') }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The endpoint must start with http:// or https://')
        if (url.pathname !== '/' || url.search || url.username) throw new Error('The endpoint must be just scheme://host[:port] — put the bucket in the Bucket field.')
        endpoint = `${url.protocol}//${url.host}`
        // Signing region: MinIO's default is us-east-1; Cloudflare R2 uses "auto"
        region = String(input.region || '').trim() || 'us-east-1'
        if (!/^[a-z0-9-]{2,32}$/.test(region)) throw new Error('Region may only contain lowercase letters, numbers and "-" (MinIO: us-east-1, Cloudflare R2: auto).')
    }

    const prefix = String(input.prefix || 'kubeez').trim().replace(/^\/+|\/+$/g, '')
    if (!PREFIX_RE.test(prefix) || prefix.includes('..')) throw new Error('Folder prefix may only contain letters, numbers, "/", "-", "_" and ".".')

    const accessKey = String(input.accessKey || '').trim() || existing?.accessKey || ''
    const secretKey = String(input.secretKey || '') || existing?.secretKey || ''
    if (!accessKey || !secretKey) throw new Error('Access key and secret key are required.')
    if (accessKey.length > 256 || secretKey.length > 256) throw new Error('Access key or secret key is too long.')

    return {
        provider, endpoint, region, bucket, prefix,
        insecureTls: provider !== 'aws' && !!input.insecureTls,
        accessKey, secretKey
    }
}

// Input travels to the node on stdin as KEY=<base64> lines — never as
// arguments. It contains presigned URLs and the bundle key, never the S3 keys.
function stdinPayload(entries) {
    return entries.map(([k, v]) => `${k}=${b64(v)}`).join('\n') + '\n'
}

function parseResult(r) {
    const out = `${r.stdout || ''}\n${r.stderr || ''}`
    const lines = out.split('\n')
    const fail = [...lines].reverse().find(l => l.startsWith('OFFSITE_FAIL|'))
    if (fail) {
        const [, code, reason] = fail.split('|')
        return { ok: false, code, error: reason }
    }
    const ok = [...lines].reverse().find(l => l.startsWith('OFFSITE_OK|'))
    if (!ok || r.code !== 0) {
        return { ok: false, code: 'NODE_ERROR', error: (out.trim().split('\n').slice(-2).join(' ') || 'The node did not respond.').slice(0, 300) }
    }
    const fields = Object.fromEntries(ok.split('|').slice(2).map(kv => kv.split('=')))
    const pick = (tag) => lines.filter(l => l.startsWith(tag + '|')).map(l => l.slice(tag.length + 1).trim())
    return { ok: true, ...fields, local: pick('LOCAL'), remote: pick('REMOTE'), uploadedNames: pick('UPLOADED'), recovery: pick('RECOVERY'), truncated: pick('TRUNCATED').length > 0 }
}

// <prefix>/<clusterId> — each cluster gets its own folder in the bucket
const folderOf = (target, clusterId) => [target.prefix, clusterId].filter(Boolean).join('/')
const bundleName = (snapshot) => snapshot.replace(/\.db$/, '.tar.gz.enc')

// Age from the bundle name (etcd-<kind>-YYYYmmdd-HHMMSS…), not storage metadata
function bundleTime(name) {
    const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/)
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null
}

/**
 * Storage that runs ON the cluster being backed up (e.g. its own S3 add-on)
 * is not offsite: losing the cluster loses the backups too. Returns a warning.
 */
export function sameClusterWarning(cluster, endpoint) {
    let host
    try { host = new URL(endpoint).hostname.toLowerCase() } catch { return null }
    const nodes = [...(cluster?.masterNodes || []), ...(cluster?.workerNodes || [])]
    const hit = nodes.find(n => [n.ip, n.hostname].filter(Boolean).map(s => String(s).toLowerCase()).includes(host))
    return hit
        ? `${host} is a node of this cluster — if the cluster is lost, these backups are lost with it. Use storage on another cluster or server (or a cloud bucket).`
        : null
}

class OffsiteService {
    async _run(cluster, mode, entries) {
        const master = etcdBackupService.firstMaster(cluster)
        let ssh
        try {
            ssh = await automationEngine.connectSSH(master)
        } catch (e) {
            return { ok: false, code: 'NODE_UNREACHABLE', error: `Cannot connect to the control-plane ${master.ip}: ${e.message}` }
        }
        try {
            await etcdBackupService.ensureTool(ssh)
            const payload = Buffer.from(stdinPayload(entries)).toString('base64')
            const r = await ssh.execCommand(`echo ${payload} | base64 -d | sudo ${NODE_TOOL} ${mode}`,
                { timeoutMs: 60 * 60 * 1000 })   // uploads of large etcd databases take a while
            return parseResult(r)
        } catch (e) {
            return { ok: false, code: 'NODE_ERROR', error: e.message }
        } finally {
            ssh?.dispose?.()
        }
    }

    _common(target, clusterId) {
        return [
            ['KZ_INSECURE', target.insecureTls ? '1' : '0'],
            ['KZ_CLUSTER', clusterId],
            ['KZ_HOST', new URL(target.endpoint).host]
        ]
    }

    /** Probe PUT/GET/DELETE from the cluster's control-plane. */
    test(cluster, target) {
        const key = `${folderOf(target, cluster.id)}/.kubeez-connection-test`
        return this._run(cluster, 'test', [
            ...this._common(target, cluster.id),
            ['KZ_PUT', presign(target, { method: 'PUT', key })],
            ['KZ_GET', presign(target, { method: 'GET', key })],
            ['KZ_DEL', presign(target, { method: 'DELETE', key })]
        ])
    }

    /** Local snapshots on the node + this cluster's offsite bundles. */
    async inventory(cluster, target) {
        const folder = folderOf(target, cluster.id)
        const r = await this._run(cluster, 'inventory', [
            ...this._common(target, cluster.id),
            ['KZ_LIST', presign(target, { method: 'GET', query: { 'list-type': '2', prefix: `${folder}/`, 'max-keys': '1000' } })]
        ])
        if (!r.ok) return r
        const remote = r.remote
            .filter(k => k.startsWith(`${folder}/`) && k.endsWith('.tar.gz.enc'))
            .map(k => k.slice(folder.length + 1))
            .filter(n => !n.includes('/'))
        return { ok: true, local: r.local, remote }
    }

    /** Offsite bundle names of this cluster. */
    async list(cluster, target) {
        const r = await this.inventory(cluster, target)
        return r.ok ? { ok: true, remote: r.remote } : r
    }

    /**
     * Fetch one offsite bundle back to the control-plane: the snapshot lands in
     * /var/lib/etcd-backup like a local one (checksummed), ready to restore.
     * `recovery`: also keep certificates + kubeadm config for rebuilding a lost
     * control-plane. `node` overrides the target machine (recovery).
     */
    async download(cluster, target, snapshot, { recovery = false } = {}) {
        if (!/^[A-Za-z0-9._-]+\.db$/.test(snapshot || '')) return { ok: false, code: 'BAD_INPUT', error: 'Invalid snapshot name' }
        const folder = folderOf(target, cluster.id)
        const r = await this._run(cluster, 'download', [
            ...this._common(target, cluster.id),
            ['KZ_ENC_KEY', target.encKey],
            ['KZ_NAME', snapshot],
            ['KZ_RECOVERY', recovery ? '1' : '0'],
            ['KZ_GET', presign(target, { method: 'GET', key: `${folder}/${bundleName(snapshot)}`, expires: 6 * 3600 })]
        ])
        if (!r.ok) return r
        return { ok: true, snapshot, kubeadm: r.recovery[0] || null }
    }

    /**
     * Upload every local snapshot that is not offsite yet, then delete offsite
     * bundles older than the retention (the newest offsite bundle is always kept).
     */
    async sync(cluster, target) {
        const inv = await this.inventory(cluster, target)
        if (!inv.ok) return inv
        const folder = folderOf(target, cluster.id)
        const remote = new Set(inv.remote)
        const toUpload = inv.local.filter(s => !remote.has(bundleName(s)))

        const all = [...new Set([...inv.remote, ...toUpload.map(bundleName)])]
        const newest = all.reduce((a, n) => ((bundleTime(n) || 0) > (bundleTime(a) || 0) ? n : a), all[0])
        const cutoff = Date.now() - ETCD_RETENTION_DAYS * 24 * 60 * 60 * 1000
        const toDelete = inv.remote.filter(n => n !== newest && bundleTime(n) !== null && bundleTime(n) < cutoff)
        // Never upload a snapshot that would be deleted right away
        const uploads = toUpload.filter(s => { const t = bundleTime(bundleName(s)); return t === null || t >= cutoff || bundleName(s) === newest })

        if (!uploads.length && !toDelete.length) {
            return { ok: true, uploaded: 0, deleted: 0, total: remote.size }
        }
        const r = await this._run(cluster, 'upload', [
            ...this._common(target, cluster.id),
            ['KZ_ENC_KEY', target.encKey],
            // Uploads may queue behind each other — give their URLs more time
            ...uploads.map(s => ['UPLOAD', `${s}|${presign(target, { method: 'PUT', key: `${folder}/${bundleName(s)}`, expires: 6 * 3600 })}`]),
            ...toDelete.map(n => ['DELETE', presign(target, { method: 'DELETE', key: `${folder}/${n}` })])
        ])
        if (!r.ok) return r
        const uploaded = parseInt(r.uploaded, 10) || 0
        const deleted = parseInt(r.deleted, 10) || 0
        return { ok: true, uploaded, deleted, total: remote.size + uploaded - deleted }
    }
}

export const offsiteService = new OffsiteService()
