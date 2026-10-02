// Boots the real backend (src/server.js) in a child process with an isolated,
// throw-away data directory, so tests never touch backend/data.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function tempDataDir(prefix = 'kubeez-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export async function startServer(extraEnv = {}) {
    const dataDir = tempDataDir()
    const port = 31000 + Math.floor(Math.random() * 8000)
    const logs = []
    const child = spawn(process.execPath, ['src/server.js'], {
        cwd: BACKEND,
        env: {
            ...process.env,
            PORT: String(port),
            KUBEEZ_MODE: 'saas',
            APP_SECRET: 'test-secret',
            NODE_ENV: 'test',
            KUBEEZ_DATA_DIR: dataDir,
            ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', d => logs.push(d.toString()))
    child.stderr.on('data', d => logs.push(d.toString()))

    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error('server exited early:\n' + logs.join(''))
        try {
            const r = await fetch(`${url}/api/health`)
            if (r.ok) break
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100))
    }

    return {
        url,
        dataDir,
        logs: () => logs.join(''),
        async stop() {
            child.kill()
            await new Promise(r => child.once('exit', r))
            fs.rmSync(dataDir, { recursive: true, force: true })
        }
    }
}

// Small JSON client: api(server)(method, path, token?, body?) → { status, data }
export function client(server) {
    return async (method, p, token, body) => {
        const r = await fetch(server.url + p, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body && method !== 'GET' ? JSON.stringify(body) : undefined
        })
        let data = null
        try { data = await r.json() } catch { /* non-JSON */ }
        return { status: r.status, data }
    }
}
