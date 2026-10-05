import fs from 'fs'
import path from 'path'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'

// Where Velero (volume backups) stores its backups — one setting per cluster.
// Keys are stored encrypted. Unlike etcd offsite bundles (presigned URLs only),
// Velero runs INSIDE the cluster and needs real keys there, so the UI
// recommends a key that can only reach this one bucket.
const FILE = path.join(DATA_DIR, 'volume-backups.json')

class VolumeBackupStore {
    _read() {
        try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} }
    }

    _write(all) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        writeFileAtomicSync(FILE, JSON.stringify(all, null, 2))
    }

    /** Full record with decrypted keys — backend use only. */
    get(clusterId) {
        const r = this._read()[clusterId]
        if (!r) return null
        return { ...r, accessKey: r.accessKey ? decrypt(r.accessKey) : '', secretKey: r.secretKey ? decrypt(r.secretKey) : '' }
    }

    /** Safe view for the UI: no keys. */
    publicView(clusterId) {
        const r = this.get(clusterId)
        if (!r) return { configured: false }
        return {
            configured: true,
            source: r.source,
            provider: r.provider,
            endpoint: r.endpoint,
            region: r.region,
            bucket: r.bucket,
            prefix: r.prefix,
            insecureTls: !!r.insecureTls,
            accessKeyHint: r.accessKey ? `••••${r.accessKey.slice(-4)}` : '',
            configuredAt: r.configuredAt
        }
    }

    save(clusterId, cfg) {
        const all = this._read()
        all[clusterId] = {
            source: cfg.source === 'offsite' ? 'offsite' : 'custom',
            provider: cfg.provider,
            endpoint: cfg.endpoint,
            region: cfg.region || 'us-east-1',
            bucket: cfg.bucket,
            prefix: cfg.prefix,
            insecureTls: !!cfg.insecureTls,
            accessKey: encrypt(cfg.accessKey),
            secretKey: encrypt(cfg.secretKey),
            configuredAt: new Date().toISOString()
        }
        this._write(all)
    }

    remove(clusterId) {
        const all = this._read()
        delete all[clusterId]
        this._write(all)
    }
}

export const volumeBackupStore = new VolumeBackupStore()
