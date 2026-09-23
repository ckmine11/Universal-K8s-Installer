import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { clusterStore } from './clusterStore.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_DIR = path.join(__dirname, '../../data')
const LICENSE_FILE = path.join(DATA_DIR, 'license.json')
const PUBLIC_KEY_FILE = path.join(DATA_DIR, 'public.pem')
const SYSTEM_ID_FILE = path.join(DATA_DIR, 'system.json')

class LicenseService {
    constructor() {
        this.ensureDataDir()
    }

    ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true })
        }
    }

    getMode() {
        return process.env.KUBEEZ_MODE || 'self-hosted'
    }

    getSystemId() {
        if (fs.existsSync(SYSTEM_ID_FILE)) {
            const data = fs.readFileSync(SYSTEM_ID_FILE, 'utf8')
            const parsed = JSON.parse(data)
            if (parsed.systemId) return parsed.systemId
        }
        
        // Generate a new System ID if it doesn't exist
        const newSystemId = `SYS-${uuidv4().split('-')[0].toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
        fs.writeFileSync(SYSTEM_ID_FILE, JSON.stringify({ systemId: newSystemId }))
        return newSystemId
    }

    parseLicenseKey(key) {
        if (!key || typeof key !== 'string') {
            throw new Error('Invalid license key format.')
        }

        if (!fs.existsSync(PUBLIC_KEY_FILE)) {
            throw new Error('System Configuration Error: Missing Public Key for License Verification.')
        }

        try {
            const publicKey = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8')
            
            // Verifies signature, expiration, and algorithm. Throws error if invalid.
            const decoded = jwt.verify(key, publicKey, { algorithms: ['RS256'] })
            
            // Validate Machine Binding (System ID)
            const currentSystemId = this.getSystemId()
            if (decoded.systemId && decoded.systemId !== currentSystemId) {
                throw new Error(`License Key is bound to a different System ID (${decoded.systemId}). Your System ID is ${currentSystemId}.`)
            }

            return { 
                plan: decoded.plan, 
                maxNodes: decoded.maxNodes, 
                maxClusters: decoded.maxClusters, 
                // jwt 'exp' is in seconds since epoch
                expiresAt: new Date(decoded.exp * 1000).toISOString(),
                systemId: decoded.systemId 
            }
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                throw new Error('This license key has expired.')
            }
            throw new Error(`Invalid or corrupted License Key: ${error.message}`)
        }
    }

    async getLicenseState() {
        const mode = this.getMode()
        const systemId = this.getSystemId()

        if (mode === 'saas') {
            return {
                mode: 'saas',
                plan: 'Pro SaaS Subscription',
                maxClusters: 5,
                maxNodes: 15,
                status: 'active',
                expiresAt: '2028-12-31T23:59:59.000Z',
                systemId
            }
        }

        // Self-Hosted Mode
        try {
            if (!fs.existsSync(LICENSE_FILE)) {
                return {
                    mode: 'self-hosted',
                    licenseKey: null,
                    plan: 'Free Tier',
                    maxClusters: 1,
                    maxNodes: 2,
                    status: 'unlicensed',
                    expiresAt: null,
                    systemId
                }
            }

            const data = await fs.promises.readFile(LICENSE_FILE, 'utf8')
            const saved = JSON.parse(data)
            if (!saved.licenseKey) {
                return {
                    mode: 'self-hosted',
                    licenseKey: null,
                    plan: 'Free Tier',
                    maxClusters: 1,
                    maxNodes: 2,
                    status: 'unlicensed',
                    expiresAt: null,
                    systemId
                }
            }

            const parsed = this.parseLicenseKey(saved.licenseKey)
            const expiryDate = new Date(parsed.expiresAt)
            const isExpired = new Date() > expiryDate

            return {
                mode: 'self-hosted',
                licenseKey: saved.licenseKey,
                plan: parsed.plan,
                maxClusters: isExpired ? 0 : parsed.maxClusters,
                maxNodes: isExpired ? 0 : parsed.maxNodes,
                status: isExpired ? 'expired' : 'active',
                expiresAt: parsed.expiresAt,
                systemId
            }
        } catch (error) {
            console.error('Error reading license file, falling back to unlicensed:', error)
            return {
                mode: 'self-hosted',
                licenseKey: null,
                plan: 'Free Tier',
                maxClusters: 1,
                maxNodes: 2,
                status: 'unlicensed',
                expiresAt: null,
                systemId
            }
        }
    }

    async activateLicense(key) {
        if (this.getMode() === 'saas') {
            throw new Error('Licensing activation is only supported in Self-Hosted mode.')
        }

        try {
            const parsed = this.parseLicenseKey(key)
            const expiryDate = new Date(parsed.expiresAt)
            if (new Date() > expiryDate) {
                throw new Error('This license key has already expired.')
            }

            const payload = {
                licenseKey: key,
                activatedAt: new Date().toISOString()
            }

            await fs.promises.writeFile(LICENSE_FILE, JSON.stringify(payload, null, 2))
            return {
                plan: parsed.plan,
                maxClusters: parsed.maxClusters,
                maxNodes: parsed.maxNodes,
                expiresAt: parsed.expiresAt,
                status: 'active',
                systemId: parsed.systemId
            }
        } catch (error) {
            console.error('Error activating license:', error)
            throw new Error(`Failed to activate license: ${error.message}`)
        }
    }

    generateLicense(plan, maxClusters, maxNodes, validityDays, systemId) {
        const privateKeyPath = path.join(__dirname, '../../scripts/vendor-keys/private.pem')
        
        if (!fs.existsSync(privateKeyPath)) {
            throw new Error('Vendor Private Key not found on this instance. You cannot generate licenses here.')
        }

        const privateKey = fs.readFileSync(privateKeyPath, 'utf8')

        const payload = {
            plan,
            maxClusters,
            maxNodes,
            systemId,
            issuer: 'KubeEZ-Vendor',
            issuedAt: new Date().toISOString()
        }

        const token = jwt.sign(payload, privateKey, {
            algorithm: 'RS256',
            expiresIn: `${validityDays}d`
        })

        return token
    }

    async checkEnforcementLimit(userId, role, newClustersCount = 0, newNodesCount = 0) {
        const mode = this.getMode()
        const state = await this.getLicenseState()
        const clusters = await clusterStore.getClusters()

        let activeClusters = []
        let activeClustersCount = 0
        let activeNodesCount = 0

        if (mode === 'saas') {
            // SaaS mode: Tenant-isolated limits. Normal users are isolated.
            if (role === 'admin') {
                // Admin in SaaS gets unlimited or high limits
                return { allowed: true }
            }

            activeClusters = clusters.filter(c => c.ownerId === userId)
            activeClustersCount = activeClusters.length
            activeNodesCount = activeClusters.reduce((sum, c) => {
                const masters = c.masterNodes?.length || 0
                const workers = c.workerNodes?.length || 0
                return sum + masters + workers
            }, 0)

            const maxClusters = state.maxClusters
            const maxNodes = state.maxNodes

            if (activeClustersCount + newClustersCount > maxClusters) {
                return {
                    allowed: false,
                    error: `Cluster limit exceeded. Your SaaS plan allows up to ${maxClusters} clusters (currently managing ${activeClustersCount}, requesting ${newClustersCount} more).`
                }
            }

            if (activeNodesCount + newNodesCount > maxNodes) {
                return {
                    allowed: false,
                    error: `Node limit exceeded. Your SaaS plan allows up to ${maxNodes} total nodes (currently using ${activeNodesCount}, requesting ${newNodesCount} more).`
                }
            }

            return { allowed: true }
        } else {
            // Self-hosted mode: Instance-wide limits. Applies to all clusters.
            activeClustersCount = clusters.length
            activeNodesCount = clusters.reduce((sum, c) => {
                const masters = c.masterNodes?.length || 0
                const workers = c.workerNodes?.length || 0
                return sum + masters + workers
            }, 0)

            const maxClusters = state.maxClusters
            const maxNodes = state.maxNodes

            if (state.status === 'expired') {
                return {
                    allowed: false,
                    error: 'License expired. Please activate a valid license key to deploy or scale clusters.'
                }
            }

            if (activeClustersCount + newClustersCount > maxClusters) {
                return {
                    allowed: false,
                    error: `Cluster limit exceeded. Your self-hosted license allows up to ${maxClusters} clusters (currently managing ${activeClustersCount}, requesting ${newClustersCount} more).`
                }
            }

            if (activeNodesCount + newNodesCount > maxNodes) {
                return {
                    allowed: false,
                    error: `Node limit exceeded. Your self-hosted license allows up to ${maxNodes} total nodes (currently using ${activeNodesCount}, requesting ${newNodesCount} more).`
                }
            }

            return { allowed: true }
        }
    }
}

export const licenseService = new LicenseService()
