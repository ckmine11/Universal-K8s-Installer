import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'
import { sameTenant } from '../utils/access.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_DIR = path.join(__dirname, '../../data')
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

    async getClusters() {
        try {
            const data = await fs.promises.readFile(CLUSTERS_FILE, 'utf8')
            const clusters = JSON.parse(data)

            // Decrypt sensitive data on load
            return clusters.map(c => ({
                ...c,
                masterNodes: this._decryptNodes(c.masterNodes),
                workerNodes: this._decryptNodes(c.workerNodes)
            }))
        } catch (error) {
            console.error('Error reading clusters:', error)
            return []
        }
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
                (sameTenant(c, cluster) && c.masterNodes && cluster.masterNodes &&
                    c.masterNodes[0]?.ip === cluster.masterNodes[0]?.ip)
            )

            const encryptedArgs = {
                ...cluster,
                masterNodes: this._encryptNodes(cluster.masterNodes),
                workerNodes: this._encryptNodes(cluster.workerNodes),
                updatedAt: new Date().toISOString()
            }

            if (idx >= 0) {
                rawClusters[idx] = { ...rawClusters[idx], ...encryptedArgs }
            } else {
                encryptedArgs.createdAt = new Date().toISOString()
                rawClusters.push(encryptedArgs)
            }

            await fs.promises.writeFile(CLUSTERS_FILE, JSON.stringify(rawClusters, null, 2))
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
                await fs.promises.writeFile(CLUSTERS_FILE, JSON.stringify(rawClusters, null, 2))
                console.log(`[ClusterStore] Backfilled orgId on ${changed} legacy cluster(s)`)
            }
            return changed
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
            await fs.promises.writeFile(CLUSTERS_FILE, JSON.stringify(newClusters, null, 2))
            return true
        } catch (error) {
            console.error('Error deleting cluster:', error)
            return false
        }
    }
}

export const clusterStore = new ClusterStore()
