// CORS: KubeEZ's own site under any name (www., a LAN IP from a phone, another
// port) can log in; other sites get no CORS headers (and no 500).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startServer } from './helpers/server.js'

let srv
before(async () => { srv = await startServer({ ALLOWED_ORIGINS: 'https://k8scluster.space' }) })
after(() => srv.stop())

// Raw request: fetch() won't let us set Host
const login = (host, origin) => new Promise((resolve, reject) => {
    const u = new URL(srv.url)
    const body = JSON.stringify({ username: 'root', password: 'secret123' })
    const req = http.request({ hostname: u.hostname, port: u.port, path: '/api/auth/login', method: 'POST',
        headers: { host, origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'], body: d }))
    })
    req.on('error', reject); req.end(body)
})

test('same site under another name can log in', async () => {
    for (const [host, origin] of [
        ['www.k8scluster.space', 'https://www.k8scluster.space'],
        ['192.168.1.20:8090', 'http://192.168.1.20:8090'],
        ['192.168.1.20', 'http://192.168.1.20:5173'],   // a proxy that drops the port
        ['k8scluster.space', 'https://k8scluster.space']
    ]) {
        const r = await login(host, origin)
        assert.equal(r.status, 200, `${origin} → ${r.status} ${r.body.slice(0, 80)}`)
        assert.equal(r.acao, origin)
    }
})

test('another site gets no CORS headers and no 500', async () => {
    const r = await login('k8scluster.space', 'https://evil.example')
    assert.notEqual(r.status, 500)
    assert.equal(r.acao, undefined)
})
