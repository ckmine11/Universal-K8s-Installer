import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DATA_DIR } from './paths.js'

const KEY_FILE = path.join(DATA_DIR, 'master.key')

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
}

// The placeholder shipped in .env.production is public (it is in the repo).
// A server running with it would let anyone forge login tokens and decrypt
// stored SSH credentials — refuse to start in production.
function checkAppSecret(secret) {
    const weak = /CHANGE_ME/i.test(secret) || secret.length < 32
    if (!weak) return
    const msg = 'APP_SECRET is the shipped placeholder or shorter than 32 characters. Generate one with: openssl rand -hex 32'
    if (process.env.NODE_ENV === 'production') {
        console.error(`[Security] ${msg}`)
        throw new Error(msg)
    }
    console.warn(`[Security] WARNING: ${msg}`)
}

let MASTER_KEY = null

function getMasterKey() {
    if (MASTER_KEY) return MASTER_KEY

    // Priority 1: Use APP_SECRET env var (deterministic, persistent across restarts)
    if (process.env.APP_SECRET) {
        checkAppSecret(process.env.APP_SECRET)
        MASTER_KEY = crypto.createHash('sha256').update(process.env.APP_SECRET).digest()
        return MASTER_KEY
    }

    // Priority 2: Load from persisted file
    if (fs.existsSync(KEY_FILE)) {
        const hexKey = fs.readFileSync(KEY_FILE, 'utf8').trim()
        MASTER_KEY = Buffer.from(hexKey, 'hex')
    } else {
        // Generate new random key and persist it — readable by the owner only
        MASTER_KEY = crypto.randomBytes(32)
        fs.writeFileSync(KEY_FILE, MASTER_KEY.toString('hex'), { mode: 0o600 })
        console.log('[CryptoUtils] Generated and saved new Master Encryption Key to', KEY_FILE)
    }
    try { fs.chmodSync(KEY_FILE, 0o600) } catch { /* not supported (e.g. Windows) */ }

    return MASTER_KEY
}

// Separate keys per purpose, derived from the master key: a leaked token-signing
// key must not decrypt stored credentials (and the other way round).
const subKey = (purpose) => crypto.createHmac('sha256', getMasterKey()).update(purpose).digest()

export function getJwtSecret() {
    return subKey('kubeez/jwt/v1').toString('hex')
}

// New values: AES-256-GCM (authenticated — a modified value fails to decrypt)
//   "v2:<iv hex>:<tag hex>:<ciphertext hex>"
// Older values ("<iv hex>:<ciphertext hex>", AES-256-CBC) still decrypt.
export function encrypt(text) {
    if (!text) return text
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', subKey('kubeez/enc/v2'), iv)
    const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
    return `v2:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ct.toString('hex')}`
}

export function decrypt(text) {
    if (!text) return text
    try {
        const parts = String(text).split(':')
        if (parts[0] === 'v2' && parts.length === 4) {
            const decipher = crypto.createDecipheriv('aes-256-gcm', subKey('kubeez/enc/v2'), Buffer.from(parts[1], 'hex'))
            decipher.setAuthTag(Buffer.from(parts[2], 'hex'))
            return Buffer.concat([decipher.update(Buffer.from(parts[3], 'hex')), decipher.final()]).toString('utf8')
        }
        // Legacy AES-256-CBC (iv:content) with the raw master key
        if (parts.length !== 2 || !/^[0-9a-f]{32}$/i.test(parts[0])) return text // not encrypted
        const decipher = crypto.createDecipheriv('aes-256-cbc', getMasterKey(), Buffer.from(parts[0], 'hex'))
        return Buffer.concat([decipher.update(Buffer.from(parts[1], 'hex')), decipher.final()]).toString()
    } catch (err) {
        // Wrong key, tampered value or plain text from an old version → as is
        return text
    }
}

// Legacy encrypt, only for tests that check old values still decrypt
export function encryptLegacyCbc(text) {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-cbc', getMasterKey(), iv)
    return iv.toString('hex') + ':' + Buffer.concat([cipher.update(text), cipher.final()]).toString('hex')
}
