import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { readDeadline } from '../src/middleware/readDeadline.js'

// A slow cluster read gets KubeEZ's own answer before Cloudflare's cut-off —
// never the proxy's HTML page; the handler's late answer is dropped quietly.
test('read deadline: slow reads get a JSON reason; fast reads, writes and streams are untouched', async () => {
    let late = null
    const app = express()
    app.use('/api', readDeadline(150))
    app.get('/api/slow', (req, res) => { setTimeout(() => { try { res.status(200).json({ late: true }); late = 'dropped' } catch (e) { late = e.message } }, 300) })
    app.get('/api/fast', (req, res) => res.json({ ok: true }))
    app.post('/api/slow', (req, res) => setTimeout(() => res.json({ ok: true }), 300))
    app.get('/api/events', (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); setTimeout(() => res.end('data: x\n\n'), 300) })
    const srv = http.createServer(app)
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${srv.address().port}`
    try {
        const slow = await fetch(url + '/api/slow')
        assert.equal(slow.status, 503)
        const j = await slow.json()
        assert.equal(j.code, 'CLUSTER_TIMEOUT')
        assert.match(j.error, /did not answer/)
        await new Promise(r => setTimeout(r, 300))
        assert.equal(late, 'dropped', 'the late answer neither throws nor reaches the browser')

        assert.deepEqual(await (await fetch(url + '/api/fast')).json(), { ok: true })
        assert.equal((await fetch(url + '/api/slow', { method: 'POST' })).status, 200)
        const ev = await fetch(url + '/api/events', { headers: { accept: 'text/event-stream' } })
        assert.equal(ev.status, 200)
        assert.match(await ev.text(), /data: x/)
    } finally { srv.close() }
})
