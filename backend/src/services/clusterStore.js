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
        if (this._isWriting) {
            await new Promise(resolve => setTimeout(resolve, 100))
            return this.saveCluster(cluster)
        }
        this._isWriting = true
        try {
            const clusters = await this.getClusters()

            // Check if cluster already exists by ID or master IP
            const existingIndex = clusters.findIndex(c =>
                c.id === cluster.id ||
                (c.masterNodes && cluster.masterNodes && c.masterNodes[0]?.ip === cluster.masterNodes[0]?.ip)
            )

            // Encrypt sensitive data before saving
            const clusterToSave = {
                ...cluster,
                masterNodes: this._encryptNodes(cluster.masterNodes),
                workerNodes: this._encryptNodes(cluster.workerNodes),
                updatedAt: new Date().toISOString(),
            }

            if (existingIndex >= 0) {
                // If updating, we need to be careful not to double-encrypt if we just read it
                // But getClusters() returns decrypted, so encrypting clusterToSave is correct.
                clusters[existingIndex] = { ...clusters[existingIndex], ...clusterToSave }
            } else {
                clusterToSave.createdAt = new Date().toISOString()
                clusters.push(clusterToSave)
            }

            // We need to re-encrypt ALL clusters because getClusters() decrypted them!
            // Wait, efficiency issue. If I load all (decrypted), modify one (encrypted), and save...
            // I need to Loop and re-encrypt everything before JSON.stringify? 
            // OR I should use a helper that operates on raw JSON?

            // Simpler: Just re-encrypt everything before saving. 
            // Since getClusters() returns Clean objects, we should save Encrypted objects.

            const rawClustersToSave = clusters.map(c => ({
                ...c,
                // Check if it's the one we just encrypted? No, clusterToSave is already encrypted.
                // But the OTHERS in `clusters` array are DECRYPTED (from getClusters).
                // So I need to re-encrypt everyone.

                // OPTIMIZATION:
                // `clusterToSave` is ALREADY encrypted by my call above.
                // The `clusters` array contains: [Decrypted1, Decrypted2, ... EncryptedNew ... ] 
                // (because I did clusters[i] = clusterToSave).

                // So I need to iterate and encrypt if Plain? 
                // How do I know? `decrypt` handles plain text nicely. `encrypt` blindly double-encrypts?
                // `encrypt` adds IV. 

                // Correct Logic:
                // 1. Read Raw File (Encrypted) -> `rawClusters`
                // 2. Find Index.
                // 3. Encrypt `cluster` -> `encryptedCluster`
                // 4. Update `rawClusters` array with `encryptedCluster`
                // 5. Save `rawClusters`.
                // This avoids decrypting/re-encrypting untouched clusters.

            }))
            // Let's rewrite the logic inside the function to use the "Read Raw" approach for safety.

            // RE-READING RAW FILE inside saveCluster is safer.
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
        // Use a simple in-memory lock to prevent race conditions during file IO
        if (this._isWriting) {
            await new Promise(resolve => setTimeout(resolve, 100))
            return this.deleteCluster(id)
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
