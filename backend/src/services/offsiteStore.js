import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// Offsite (S3 / MinIO) backup target — one per workspace (orgId).
// Secrets (access/secret key, bundle encryption key) are stored encrypted.
// The bundle encryption key is NEVER deleted (not even on disconnect): it is
// the only way to decrypt bundles that were already uploaded.
const FILE = path.join(DATA_DIR, 'offsite.json')

export const PROVIDERS = ['aws', 'minio', 'other']

class OffsiteStore {
    _read() {
        try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} }
    }

    _write(all) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        writeFileAtomicSync(FILE, JSON.stringify(all, null, 2))
    }

    /** Full record incl. decrypted secrets — backend use only. */
    get(orgId) {
        const r = this._read()[orgId]
        if (!r) return null
        return {
            ...r,
            accessKey: r.accessKey ? decrypt(r.accessKey) : '',
            secretKey: r.secretKey ? decrypt(r.secretKey) : '',
            encKey: r.encKey ? decrypt(r.encKey) : ''
        }
    }

    /** Connected target (or null) with secrets — what the node needs. */
    getConnected(orgId) {
        const r = this.get(orgId)
        return r?.connected ? r : null
    }

    /** Safe view for the UI: no secrets. */
    publicView(orgId) {
        const r = this.get(orgId)
        if (!r) return { connected: false }
        return {
            connected: !!r.connected,
            provider: r.provider,
            endpoint: r.endpoint,
            region: r.region || '',
            bucket: r.bucket,
            prefix: r.prefix || '',
            insecureTls: !!r.insecureTls,
            accessKeyHint: r.accessKey ? `••••${r.accessKey.slice(-4)}` : '',
            connectedAt: r.connectedAt || null,
            hasRecoveryKey: !!r.encKey,
            lastSync: r.lastSync || {}
        }
    }

    /**
     * Save a tested connection. Returns { recoveryKey } when a new bundle
     * encryption key was generated (first connect) — shown to the user once.
     */
    connect(orgId, cfg) {
        const all = this._read()
        const prev = all[orgId] || {}
        let recoveryKey = null
        let encKey = prev.encKey
        if (!encKey) {
            recoveryKey = crypto.randomBytes(32).toString('hex')
            encKey = encrypt(recoveryKey)
        }
        all[orgId] = {
            provider: cfg.provider,
            endpoint: cfg.endpoint,
            region: cfg.region || '',
            bucket: cfg.bucket,
            prefix: cfg.prefix || '',
            insecureTls: !!cfg.insecureTls,
            accessKey: encrypt(cfg.accessKey),
            secretKey: encrypt(cfg.secretKey),
            encKey,
            connected: true,
            connectedAt: new Date().toISOString(),
            lastSync: prev.lastSync || {}
        }
        this._write(all)
        return { recoveryKey }
    }

    disconnect(orgId) {
        const all = this._read()
        if (!all[orgId]) return
        // Drop the storage credentials, keep the encryption key for old bundles
        all[orgId] = { ...all[orgId], connected: false, accessKey: '', secretKey: '' }
        this._write(all)
    }

    recordSync(orgId, clusterId, result) {
        const all = this._read()
        if (!all[orgId]) return
        const { ok, code, error, uploaded, deleted, total } = result || {}
        all[orgId].lastSync = {
            ...(all[orgId].lastSync || {}),
            [clusterId]: { ok: !!ok, code, error, uploaded, deleted, total, at: new Date().toISOString() }
        }
        this._write(all)
    }
}

export const offsiteStore = new OffsiteStore()
