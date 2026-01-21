import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

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

    async getClusters() {
        try {
            const data = await fs.promises.readFile(CLUSTERS_FILE, 'utf8')
            return JSON.parse(data)
        } catch (error) {
            console.error('Error reading clusters:', error)
            return []
        }
    }

    async saveCluster(cluster) {
        try {
            const clusters = await this.getClusters()

            // Check if cluster already exists by ID or master IP
            const existingIndex = clusters.findIndex(c =>
                c.id === cluster.id ||
                (c.masterNodes && cluster.masterNodes && c.masterNodes[0]?.ip === cluster.masterNodes[0]?.ip)
            )

            const clusterToSave = {
                ...cluster,
                updatedAt: new Date().toISOString(),
                // Ensure we don't save sensitive data in logs, but keep node configs for future scaling
            }

            if (existingIndex >= 0) {
                clusters[existingIndex] = { ...clusters[existingIndex], ...clusterToSave }
            } else {
                clusterToSave.createdAt = new Date().toISOString()
                clusters.push(clusterToSave)
            }

            await fs.promises.writeFile(CLUSTERS_FILE, JSON.stringify(clusters, null, 2))
            return true
        } catch (error) {
            console.error('Error saving cluster:', error)
            return false
        }
    }

    async deleteCluster(id) {
        try {
            let clusters = await this.getClusters()
            clusters = clusters.filter(c => c.id !== id)
            await fs.promises.writeFile(CLUSTERS_FILE, JSON.stringify(clusters, null, 2))
            return true
        } catch (error) {
            console.error('Error deleting cluster:', error)
            return false
        }
    }
}

export const clusterStore = new ClusterStore()
