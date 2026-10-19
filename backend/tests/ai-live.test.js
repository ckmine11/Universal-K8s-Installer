// Ask AI: answers that appear as they are written (streamed from OpenAI-compatible
// engines, shown through the job's "partial"), and a conversation it remembers
// ("which pod is failing?" → "show its logs" → "how do I fix it?").
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tempDataDir, startServer, client } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'

const { ask } = await import('../src/services/ai/engine.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { parseSnapshot, _setSnapshot } = await import('../src/services/ai/clusterQuery.js')
const { handleChat, resetChat } = await import('../src/services/ai/chatops.js')
const { automationEngine } = await import('../src/services/automationEngine.js')

// a fake OpenAI-compatible model: streams word by word when asked to
const WORDS = ['A ', 'DaemonSet ', 'runs ', 'one ', 'pod ', 'on ', 'every ', 'node.']
let seen = [], reply = null, delay = 30
const model = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c)
    req.on('end', async () => {
        const body = JSON.parse(b || '{}'); seen.push(body)
        const text = typeof reply === 'function' ? reply(body) : reply
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            const parts = text ? text.match(/\S+\s*/g) : WORDS
            for (const w of parts) { res.write(`data: ${JSON.stringify({ model: 'm', choices: [{ delta: { content: w } }] })}\n\n`); await new Promise(r => setTimeout(r, delay)) }
            res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: parts.length } })}\n\n`)
            res.end('data: [DONE]\n\n')
            return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ model: 'm', choices: [{ message: { content: text || WORDS.join('') } }], usage: { prompt_tokens: 50, completion_tokens: 8 } }))
    })
})
const base = () => `http://127.0.0.1:${model.address().port}/v1`
before(async () => { await new Promise(r => model.listen(0, '127.0.0.1', r)) })
after(() => { model.closeAllConnections?.(); model.close(); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('answers as they are written', () => {
    test('the engine streams: every piece arrives, the final answer is checked as usual', async () => {
        const org = 'org-stream'
        aiStore.addProvider(org, { name: 'Live', kind: 'openai', preset: 'other-local', offline: true, baseUrl: base(), model: 'm' })
        reply = null; seen = []
        const parts = []
        const r = await ask({ id: 'u', username: 'u', orgId: org }, { task: 'chat', question: 'What is a DaemonSet?', onToken: (t) => parts.push(t) })
        assert.equal(r.text, 'A DaemonSet runs one pod on every node.')
        assert.equal(seen[0].stream, true)
        assert.equal(parts[0], '', 'starts empty')
        assert.ok(parts.length >= 8, `arrived in pieces (${parts.length})`)
        assert.ok(parts.slice(1).every((p, i, a) => i === 0 || p.length >= a[i - 1].length), 'each piece adds to the last')
        assert.equal(parts.at(-1), r.text)
    })
    test('JSON answers are not streamed (they are checked as a whole)', async () => {
        const org = 'org-stream'
        reply = '{"summary":"ok summary text","cause":"a cause that is long enough","fix":["x"],"evidence":[],"confidence":"low","missing":""}'; seen = []
        await ask({ id: 'u', username: 'u', orgId: org }, { task: 'explain', json: true, question: 'why?', onToken: () => { }, validate: () => null })
        assert.equal(seen[0].stream, undefined)
    })
    test('an answer rejected while streaming (not English) starts over with the retry', async () => {
        const org = 'org-stream2'
        aiStore.addProvider(org, { name: 'Live', kind: 'openai', preset: 'other-local', offline: true, baseUrl: base(), model: 'm' })
        let n = 0; reply = () => (++n === 1 ? 'DaemonSet har node pe ek pod chalata hai.' : 'A DaemonSet runs one pod on every node.')
        const parts = []
        const r = await ask({ id: 'u', username: 'u', orgId: org }, { task: 'chat', question: 'daemonset kya hota hai?', onToken: (t) => parts.push(t) })
        assert.equal(r.text, 'A DaemonSet runs one pod on every node.')
        assert.ok(parts.filter(p => p === '').length >= 2, 'the shown text was reset for the retry')
    })
})

describe('a conversation it remembers', () => {
    const org = 'org-conv'
    const now = new Date().toISOString()
    const cluster = { id: 'cv1', clusterName: 'prod', orgId: org, ownerId: 'u', k8sVersion: '1.36.0', status: 'completed', masterNodes: [{ ip: '10.0.0.10' }], workerNodes: [] }
    const SNAP = parseSnapshot(['==NS==', `default\tActive\t${now}`, `shop\tActive\t${now}`, '==NODES==', 'n1\tTrue\tv1.36.0\t4\t8Gi\t{}\t10.0.0.10\t',
        '==PODS==', 'shop\tweb-6d4f9-b2\tRunning\tfalse,\t14,\tCrashLoopBackOff,\tn1\tReplicaSet\tnginx:1.27 \tweb-6d4f9', 'shop\tapi-1\tRunning\ttrue,\t0,\t,\tn1\tReplicaSet\tapi:1 \tapi-5',
        '==DEPLOY==', 'shop\tweb\t1\t0', '==STS==', '==DS==', '==SVC==', '==PVC==', '==ING==', '==JOBS==', '==EVENTS==', '==END=='].join('\n'))
    const admin = { id: 'a1', username: 'boss', orgId: org, role: 'admin' }
    const cmds = []
    before(() => {
        fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([cluster]))
        _setSnapshot('cv1', SNAP)
        automationEngine.connectSSH = async () => ({ execCommand: async (cmd) => { cmds.push(cmd); return { stdout: / logs /.test(cmd) ? 'Error: connect ECONNREFUSED 10.96.7.7:5432' : /describe pod/.test(cmd) ? 'Events:\n  Warning BackOff' : '' } }, dispose() { } })
        aiStore.addProvider(org, { name: 'Live', kind: 'openai', preset: 'other-local', offline: true, baseUrl: base(), model: 'm' })
    })
    const chat = (text) => handleChat({ orgId: org, chatKey: 'web:a1', who: 'boss', source: 'Web', text, user: admin, rate: 60 })

    test('the next question sees the conversation so far', async () => {
        reply = 'web-6d4f9-b2 in shop is crash-looping (14 restarts).'; seen = []
        await chat('which pod is failing?')
        reply = 'It keeps restarting because it cannot reach its database.'; seen = []
        await chat('why does it keep restarting?')
        const msgs = seen[0].messages.filter(m => m.role !== 'system')
        assert.deepEqual(msgs.slice(0, 2).map(m => m.role), ['user', 'assistant'])
        assert.match(msgs[0].content, /which pod is failing/)
        assert.match(msgs[1].content, /web-6d4f9-b2 in shop is crash-looping/)
    })
    test('"show its logs" checks the pod the conversation is about', async () => {
        reply = (body) => body.response_format || /JSON/.test(JSON.stringify(body.messages)) ? JSON.stringify({ summary: 'web-6d4f9-b2 cannot reach its database.', cause: 'The database refuses connections.', evidence: ['Error: connect ECONNREFUSED 10.96.7.7:5432'], fix: ['Check the database'], confidence: 'high', missing: '' }) : 'ok'
        await chat('check the logs of web-6d4f9-b2')
        cmds.length = 0
        const r = await chat('show its logs again')
        assert.ok(cmds.some(c => /logs web-6d4f9-b2 -n shop/.test(c)), `the same pod (${cmds.join(' | ').slice(0, 200)})`)
        assert.match(r.reply, /^🔎 prod: shop\/web-6d4f9-b2/)
    })
    test('"Clear" forgets: no conversation, no pod to refer back to', async () => {
        resetChat('web:a1')
        reply = 'Which one do you mean?'; seen = []
        await chat('what is wrong with it?')
        assert.equal(seen[0].messages.filter(m => m.role === 'assistant').length, 0, 'no earlier answers sent')
    })
})

describe('the API shows the answer while it is written', () => {
    let srv, api, boss
    before(async () => {
        srv = await startServer({ KUBEEZ_MODE: 'selfhosted', NO_SUPERADMIN: '1' })
        api = client(srv)
        boss = (await api('POST', '/api/auth/setup', null, { username: 'liveboss', password: 'bosspass123', email: 'liveboss@example.com' })).data
        const p = await api('POST', '/api/ai/providers', boss.token, { preset: 'other-local', name: 'Live', baseUrl: base(), model: 'm' })
        assert.equal(p.status, 200, JSON.stringify(p.data))
    })
    after(() => srv?.stop())
    test('a job id at once; then the partial answer grows; then the full answer', async () => {
        reply = 'A DaemonSet runs one pod on every node of the cluster, for example a log collector or a monitoring agent, and adds it to new nodes as they join.'; delay = 120
        const first = await api('POST', '/api/ai/chat', boss.token, { text: 'What is a DaemonSet?' })
        assert.equal(first.status, 202); assert.ok(first.data.jobId)
        const partials = []
        let r
        for (let i = 0; i < 80; i++) {
            await new Promise(x => setTimeout(x, 150))
            r = await api('GET', `/api/ai/jobs/${first.data.jobId}`, boss.token)
            if (r.status === 202 && r.data.partial) partials.push(r.data.partial)
            if (r.status === 200) break
        }
        delay = 30
        assert.equal(r.status, 200)
        assert.match(r.data.reply, /^A DaemonSet runs one pod on every node/)
        assert.ok(partials.length >= 2, `seen while being written (${partials.length} times)`)
        assert.ok(partials[0].length < r.data.reply.length)
        assert.equal((await api('POST', '/api/ai/chat/reset', boss.token, {})).status, 200)
    })
})
