import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'
import { sameTenant } from '../utils/access.js'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomic } from '../utils/atomicWrite.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)


const CLUSTERS_FILE = path.join(DATA_DIR, 'clusters.json')

class ClusterStore {
    constructor() {
        this.ensureDataDir()
    }

    ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
        if (!fs.existsSync(CLUSTERS_FILE)) {
            fs.writeFileSync(CLUSTERS_FILE, JSON.stringify([]))
        }
    }

    _encryptNodes(nodes) {
        if (!nodes) return []
        return nodes.map(n => ({
            ...n,
            password: n.password ? encrypt(n.password) : n.password,
            sshKey: n.sshKey ? encrypt(n.sshKey) : n.sshKey
        }))
    }

    _decryptNodes(nodes) {
        if (!nodes) return []
        return nodes.map(n => ({
            ...n,
            password: n.password ? decrypt(n.password) : n.password,
            sshKey: n.sshKey ? decrypt(n.sshKey) : n.sshKey
        }))
    }

    // Nearly every request reads the clusters (the permission check, then the
    // route), and decrypting every node's login each time blocked the event
    // loop ~9 ms per read at 50 clusters. The decrypted list is kept until the
    // file changes (our own writes clear it; any other writer changes its
    // mtime or size); each caller gets its own copy.
    async _write(json) {
        this._cache = null
        await writeFileAtomic(CLUSTERS_FILE, json)
        this._cache = null
    }

    async getClusters() {
        try {
            const st = await fs.promises.stat(CLUSTERS_FILE)
            const c = this._cache
            if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return structuredClone(c.data)
            const data = this._decryptAll(await fs.promises.readFile(CLUSTERS_FILE, 'utf8'))
            this._cache = { mtimeMs: st.mtimeMs, size: st.size, data }
            return structuredClone(data)
        } catch (error) {
            console.error('Error reading clusters:', error)
            return []
        }
    }

    _decryptAll(text) {
        const clusters = JSON.parse(text)

            // Decrypt sensitive data on load. Every node also carries its
            // cluster's ownerId/orgId so SSH (upgrade, etcd, health, add-ons…)
            // routes through the tenant's Gateway Agent when one is online.
            const tag = (c) => (n) => ({ ...n, ownerId: n.ownerId || c.ownerId, orgId: n.orgId || c.orgId })
            return clusters.map(c => ({
                ...c,
                masterNodes: this._decryptNodes(c.masterNodes).map(tag(c)),
                workerNodes: this._decryptNodes(c.workerNodes).map(tag(c)),
                ...(c.sshNodes ? { sshNodes: this._decryptNodes(c.sshNodes).map(tag(c)) } : {})
            }))
    }

    // Serialize every read-modify-write of clusters.json (also used by
    // BackupService.restoreBackup) so concurrent writers can't lose updates.
    async withLock(fn) {
        const run = (this._lock || Promise.resolve()).then(() => fn())
        this._lock = run.catch(() => {})
        return run
    }

    async saveCluster(cluster) {
        return this.withLock(() => this._saveCluster(cluster))
    }

    async _saveCluster(cluster) {
        try {
            // Read raw (encrypted) file to avoid double-encrypting untouched clusters
            const rawData = await fs.promises.readFile(CLUSTERS_FILE, 'utf8').catch(() => '[]')
            const rawClusters = JSON.parse(rawData)

            // Match by id, or by master IP within the SAME tenant only — never
            // let one tenant's install overwrite another tenant's record.
            const idx = rawClusters.findIndex(c =>
                c.id === cluster.id ||
                // (an imported cluster has no node IP — two of them must never match)
                (sameTenant(c, cluster) && c.masterNodes?.[0]?.ip && cluster.masterNodes?.[0]?.ip &&
                    c.masterNodes[0].ip === cluster.masterNodes[0].ip)
            )

            const encryptedArgs = {
                ...cluster,
                masterNodes: this._encryptNodes(cluster.masterNodes),
                workerNodes: this._encryptNodes(cluster.workerNodes),
                ...(cluster.sshNodes ? { sshNodes: this._encryptNodes(cluster.sshNodes) } : {}),
                updatedAt: new Date().toISOString()
            }

            if (idx >= 0) {
                rawClusters[idx] = { ...rawClusters[idx], ...encryptedArgs }
            } else {
                encryptedArgs.createdAt = new Date().toISOString()
                rawClusters.push(encryptedArgs)
            }

            await this._write(JSON.stringify(rawClusters, null, 2))
            return true

        } catch (error) {
            console.error('Error saving cluster:', error)
            return false
        }
    }

    // One-time migration: clusters completed before orgId was persisted only
    // carry ownerId, which hides them from the owner's team members. Stamp the
    // owner's current orgId onto them. Raw file edit — credentials untouched.
    async backfillOrgIds(resolveOrgId) {
        return this.withLock(async () => {
            const rawData = await fs.promises.readFile(CLUSTERS_FILE, 'utf8').catch(() => '[]')
            const rawClusters = JSON.parse(rawData)
            let changed = 0
            for (const c of rawClusters) {
                if (c.orgId || !c.ownerId) continue
                const orgId = resolveOrgId(c.ownerId)
                if (orgId) { c.orgId = orgId; changed++ }
            }
            if (changed > 0) {
                await this._write(JSON.stringify(rawClusters, null, 2))
                console.log(`[ClusterStore] Backfilled orgId on ${changed} legacy cluster(s)`)
            }
            return changed
        })
    }

    // Labels (env=prod, team=payments) for cluster access rules — only the
    // labels change; the stored node credentials are not touched
    async setLabels(id, labels) {
        return this.withLock(async () => {
            const raw = JSON.parse(await fs.promises.readFile(CLUSTERS_FILE, 'utf8').catch(() => '[]'))
            const c = raw.find(x => x.id === id)
            if (!c) return null
            if (Object.keys(labels).length) c.labels = labels; else delete c.labels
            c.updatedAt = new Date().toISOString()
            await this._write(JSON.stringify(raw, null, 2))
            return c.labels || {}
        })
    }

    async deleteCluster(id) {
        return this.withLock(() => this._deleteCluster(id))
    }

    async _deleteCluster(id) {
        try {
            // CRITICAL FIX: Read RAW file to preserve encryption of other clusters
            const rawData = await fs.promises.readFile(CLUSTERS_FILE, 'utf8').catch(() => '[]')
            let rawClusters = JSON.parse(rawData)

            // Filter out the deleted cluster
            const newClusters = rawClusters.filter(c => c.id !== id)

            // Write back the raw (still encrypted) data
            await this._write(JSON.stringify(newClusters, null, 2))
            return true
        } catch (error) {
            console.error('Error deleting cluster:', error)
            return false
        }
    }
}

export const clusterStore = new ClusterStore()
