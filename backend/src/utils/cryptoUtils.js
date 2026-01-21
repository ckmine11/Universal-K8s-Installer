import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DATA_DIR = path.join(__dirname, '../../data')
const KEY_FILE = path.join(DATA_DIR, 'master.key')
const ALGORITHM = 'aes-256-cbc'

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
}

let MASTER_KEY = null

function getMasterKey() {
    if (MASTER_KEY) return MASTER_KEY

    // Try to load from env
    if (process.env.APP_SECRET) {
        // Pad or truncate to 32 bytes
        return crypto.createHash('sha256').update(process.env.APP_SECRET).digest()
    }

    // Try to load from file
    if (fs.existsSync(KEY_FILE)) {
        const hexKey = fs.readFileSync(KEY_FILE, 'utf8').trim()
        MASTER_KEY = Buffer.from(hexKey, 'hex')
    } else {
        // Generate new random key
        MASTER_KEY = crypto.randomBytes(32)
        fs.writeFileSync(KEY_FILE, MASTER_KEY.toString('hex'))
        console.log('Generated new Master Encryption Key')
    }

    return MASTER_KEY
}

export function getJwtSecret() {
    return getMasterKey().toString('hex')
}

export function encrypt(text) {
    if (!text) return text
    const key = getMasterKey()
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key), iv)
    let encrypted = cipher.update(text)
    encrypted = Buffer.concat([encrypted, cipher.final()])
    return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(text) {
    if (!text) return text
    try {
        const textParts = text.split(':')
        // Check if it looks encrypted (iv:content)
        if (textParts.length !== 2) return text // Return original if not encrypted

        const iv = Buffer.from(textParts[0], 'hex')
        const encryptedText = Buffer.from(textParts[1], 'hex')
        const key = getMasterKey()
        const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key), iv)
        let decrypted = decipher.update(encryptedText)
        decrypted = Buffer.concat([decrypted, decipher.final()])
        return decrypted.toString()
    } catch (err) {
        // If decryption fails (e.g. wrong key or plain text), return original
        // This is important for migration from plain text
        return text
    }
}
