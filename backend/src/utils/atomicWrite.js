import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

// Write a data file so readers always see either the complete old or the
// complete new content: write a temp file next to it, then rename over it
// (rename is atomic). Plain writeFile truncates first — a read in between, or
// a crash / power loss mid-write, saw an empty or half file (lost users,
// clusters; agents told their token was invalid).
const tmpName = (file) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)

// Windows refuses to replace a file another handle has open (a reader) —
// those errors are momentary, so retry briefly. Linux never hits this.
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRIES = 40

async function renameWithRetry(from, to) {
    for (let i = 0; ; i++) {
        try { return await fs.promises.rename(from, to) } catch (e) {
            if (!RETRYABLE.has(e.code) || i >= RETRIES) throw e
            await new Promise(r => setTimeout(r, 5 + i * 5))
        }
    }
}
function renameWithRetrySync(from, to) {
    for (let i = 0; ; i++) {
        try { return fs.renameSync(from, to) } catch (e) {
            if (!RETRYABLE.has(e.code) || i >= RETRIES) throw e
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + i * 5)
        }
    }
}

export async function writeFileAtomic(file, data, options = {}) {
    const tmp = tmpName(file)
    try {
        await fs.promises.writeFile(tmp, data, options)
        await renameWithRetry(tmp, file)
    } catch (e) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {})
        throw e
    }
}

export function writeFileAtomicSync(file, data, options = {}) {
    const tmp = tmpName(file)
    try {
        fs.writeFileSync(tmp, data, options)
        renameWithRetrySync(tmp, file)
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
        throw e
    }
}
