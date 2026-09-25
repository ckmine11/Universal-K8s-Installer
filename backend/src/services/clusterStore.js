import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'

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

    async saveCluster(cluster) {
        let waited = 0
        while (this._isWriting) {
            if (waited >= 5000) throw new Error('Cluster store write timeout: lock held too long')
            await new Promise(resolve => setTimeout(resolve, 100))
            waited += 100
        }
        this._isWriting = true
        try {
            // Read raw (encrypted) file to avoid double-encrypting untouched clusters
            const rawData = await fs.promises.readFile(CLUSTERS_FILE, 'utf8').catch(() => '[]')
            const rawClusters = JSON.parse(rawData)

            const idx = rawClusters.findIndex(c =>
                c.id === cluster.id ||
                (c.masterNodes && cluster.masterNodes && c.masterNodes[0]?.ip === cluster.masterNodes[0]?.ip)
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
        } finally {
            this._isWriting = false
        }
    }

    async deleteCluster(id) {
        let waited = 0
        while (this._isWriting) {
            if (waited >= 5000) throw new Error('Cluster store write timeout: lock held too long')
            await new Promise(resolve => setTimeout(resolve, 100))
            waited += 100
        }

        this._isWriting = true
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
        } finally {
            this._isWriting = false
        }
    }
}

export const clusterStore = new ClusterStore()
