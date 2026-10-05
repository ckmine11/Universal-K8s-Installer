// Data files must never be seen half-written (a reader during a write used to
// get an empty/partial file: "no agents", "invalid agent token", lost data).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'
import { writeFileAtomic } from '../src/utils/atomicWrite.js'

test('concurrent readers always see a complete file', async () => {
    const file = path.join(tempDataDir(), 'agents.json')
    const big = (n) => JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, n, token: 'x'.repeat(40) })))
    await writeFileAtomic(file, big(0))
    let partial = 0
    let stop = false
    const reader = (async () => {
        while (!stop) {
            try { JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch { partial++ }
            await new Promise(r => setImmediate(r))
        }
    })()
    for (let n = 1; n <= 60; n++) await writeFileAtomic(file, big(n))
    stop = true
    await reader
    assert.equal(partial, 0)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].n, 60)
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), [], 'no temp files left')
})
