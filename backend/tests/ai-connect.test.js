// Connect AI: any model, offline or cloud. Fake offline runtimes (LM Studio-,
// vLLM-, llama.cpp-, TGI-like and a keyless OpenAI-compatible server), live
// model lists with labels and "new" marks, the base-address fix, JSON-mode
// fallback for servers that reject it, and the /api/ai routes (presets, keys
// only where needed, SaaS address rules, the quality test after adding).
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { startServer, client, tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'   // the fake runtimes run on localhost

const { classify, suggestModel, detectRuntime, normalizeBase, discover, modelsOf, remember, newCount } = await import('../src/services/ai/modelCatalog.js')
const { PRESETS, presetOf } = await import('../src/config/aiPresets.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')
const { ask } = await import('../src/services/ai/engine.js')

// a fake runtime: which extra endpoints it has decides what it "is"
function fakeRuntime({ kind = 'lmstudio', models = ['qwen2.5-7b-instruct', 'text-embedding-nomic-embed-text-v1.5'], key = null, rejectJsonMode = false } = {}) {
    const seen = []
    const srv = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c)
        req.on('end', () => {
            const body = b ? JSON.parse(b) : {}
            seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || null })
            const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
            if (key && req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: 'Invalid API key' } })
            if (req.url === '/v1/models') return send(200, { data: models.map(id => ({ id })) })
            if (kind === 'lmstudio' && req.url === '/api/v0/models') return send(200, { data: models.map(id => ({ id })) })
            if (kind === 'vllm' && req.url === '/version') return send(200, { version: '0.9.1' })
            if (kind === 'tgi' && req.url === '/info') return send(200, { model_id: models[0] })
            if (kind === 'llamacpp' && req.url === '/props') return send(200, { default_generation_settings: {}, total_slots: 1 })
            if (req.url === '/v1/chat/completions') {
                if (rejectJsonMode && body.response_format) return send(400, { error: { message: "Unrecognized request argument supplied: response_format" } })
                const content = body.response_format || /JSON/.test(JSON.stringify(body.messages)) ? JSON.stringify({ summary: 'The pod runs out of memory.', cause: 'Its memory limit is too low.', evidence: [], fix: ['Raise the memory limit'], confidence: 'medium', missing: '' }) : 'A DaemonSet runs one pod on every node.'
                return send(200, { model: body.model, choices: [{ message: { content } }] })
            }
            send(404, { error: 'not found' })
        })
    })
    return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ root: `http://127.0.0.1:${srv.address().port}`, seen, close: () => { srv.closeAllConnections?.(); srv.close() } })))
}
after(() => { process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('the presets', () => {
    test('offline runtimes beyond Ollama, the add-on, and the cloud providers', () => {
        const ids = PRESETS.map(p => p.id)
        for (const id of ['ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai', 'tgi', 'jan', 'koboldcpp', 'textgen-webui', 'other-local', 'kubeez-addon']) assert.ok(ids.includes(id), id)
        for (const id of ['anthropic', 'gemini', 'openai', 'openrouter', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'xai', 'other-cloud']) assert.ok(ids.includes(id), id)
        assert.ok(PRESETS.filter(p => p.group === 'offline').every(p => !p.needsKey), 'offline runtimes need no key')
        assert.ok(PRESETS.filter(p => p.group === 'cloud').every(p => p.needsKey), 'cloud APIs need a key')
        assert.ok(PRESETS.filter(p => p.group === 'cloud' && p.baseUrl).every(p => p.baseUrl.startsWith('https://')))
        assert.equal(presetOf('vllm').kind, 'openai')
    })
})

describe('model lists', () => {
    test('chat models only, labelled, the good ones first', () => {
        const m = classify(['text-embedding-3-small', 'whisper-1', 'tts-1', 'dall-e-3', 'gpt-4.1-mini', 'gpt-4.1', 'omni-moderation-latest', 'claude-haiku-4-5', 'llama-3.3-70b-versatile', 'some-model', 'qwen2.5:7b', 'qwen2.5:0.5b', 'nomic-embed-text'])
        const ids = m.map(x => x.id)
        assert.equal(ids.some(id => /embed|whisper|tts|dall-e|moderation/.test(id)), false, 'no embeddings, speech, images, moderation')
        assert.ok(ids.indexOf('gpt-4.1-mini') < ids.indexOf('some-model'))
        const by = Object.fromEntries(m.map(x => [x.id, x]))
        assert.equal(by['claude-haiku-4-5'].recommended, true); assert.equal(by['claude-haiku-4-5'].fast, true)
        assert.equal(by['llama-3.3-70b-versatile'].large, true)
        assert.equal(by['qwen2.5:7b'].recommended, true); assert.equal(by['qwen2.5:0.5b'].recommended, false)
        const pick = by[suggestModel(m)]
        assert.ok(pick.recommended && pick.fast, `recommended and fast is preselected (${pick.id})`)
    })
    test('"new" = first seen in the last 14 days, after the first list', () => {
        const base = new Date(Date.now() - 30 * 86400e3).toISOString()
        const known = { 'old-model': base, 'fresh-model': new Date(Date.now() - 2 * 86400e3).toISOString(), 'month-old': new Date(Date.now() - 20 * 86400e3).toISOString() }
        const m = Object.fromEntries(classify(Object.keys(known), { known, baseline: base }).map(x => [x.id, x.new]))
        assert.deepEqual(m, { 'old-model': false, 'fresh-model': true, 'month-old': false })
    })
})

describe('offline runtimes', () => {
    test('which runtime answers, and the /v1 address fixed', async () => {
        for (const [kind, label] of [['lmstudio', 'LM Studio'], ['vllm', 'vLLM'], ['tgi', 'Hugging Face TGI'], ['llamacpp', 'llama.cpp'], ['plain', null]]) {
            const rt = await fakeRuntime({ kind })
            assert.equal(await detectRuntime(rt.root), label, kind)
            assert.equal(await normalizeBase(rt.root), `${rt.root}/v1`, 'the user typed it without /v1')
            rt.close()
        }
    })
    test('connect without a key: the live models, embeddings left out, one suggested', async () => {
        const rt = await fakeRuntime({ kind: 'lmstudio', models: ['qwen2.5-7b-instruct', 'llama-3.2-3b-instruct', 'text-embedding-nomic-embed-text-v1.5'] })
        const r = await discover({ kind: 'openai', offline: true, baseUrl: rt.root }, null)
        assert.equal(r.ok, true, r.detail)
        assert.equal(r.runtime, 'LM Studio')
        assert.equal(r.baseUrl, `${rt.root}/v1`)
        assert.deepEqual(r.models.map(m => m.id).sort(), ['llama-3.2-3b-instruct', 'qwen2.5-7b-instruct'])
        assert.ok(r.suggested)
        assert.equal(rt.seen.some(s => s.auth), false, 'no key sent when there is none')
        rt.close()
    })
    test('a server with a key: the key is sent', async () => {
        const rt = await fakeRuntime({ kind: 'vllm', key: 'local-secret', models: ['Qwen/Qwen2.5-14B-Instruct'] })
        assert.equal((await discover({ kind: 'openai', offline: true, baseUrl: `${rt.root}/v1` }, 'wrong')).ok, false)
        const r = await discover({ kind: 'openai', offline: true, baseUrl: `${rt.root}/v1` }, 'local-secret')
        assert.equal(r.ok, true); assert.deepEqual(r.models.map(m => m.id), ['Qwen/Qwen2.5-14B-Instruct'])
        rt.close()
    })
    test('answers through any OpenAI-compatible runtime — and JSON mode falls back when the server rejects it', async () => {
        const rt = await fakeRuntime({ kind: 'llamacpp', rejectJsonMode: true, models: ['local-model'] })
        const org = 'org-local'
        const p = aiStore.addProvider(org, { name: 'llama.cpp', kind: 'openai', preset: 'llamacpp', offline: true, baseUrl: `${rt.root}/v1`, model: 'local-model' })
        assert.equal(p.offline, true); assert.equal(p.preset, 'llamacpp')
        const user = { id: 'u', username: 'u', orgId: org, role: 'admin' }
        const r = await ask(user, { task: 'chat', question: 'What is a DaemonSet?' })
        assert.equal(r.text, 'A DaemonSet runs one pod on every node.')
        const j = await ask(user, { task: 'explain', json: true, question: 'Why does the pod restart?', validate: (x) => x.summary ? null : 'no summary' })
        assert.equal(j.json.summary, 'The pod runs out of memory.')
        const chats = rt.seen.filter(s => s.url === '/v1/chat/completions')
        assert.ok(chats.some(s => s.body.response_format) && chats.some(s => !s.body.response_format && /JSON/.test(JSON.stringify(s.body.messages))), 'asked again without the JSON-mode field')
        rt.close()
    })
    test('a saved engine: its models live, new ones marked from the second look on', async () => {
        const models = ['qwen2.5-7b-instruct']
        const rt = await fakeRuntime({ kind: 'lmstudio', models })
        const org = 'org-new'
        const p = aiStore.addProvider(org, { name: 'LM Studio', kind: 'openai', preset: 'lmstudio', offline: true, baseUrl: `${rt.root}/v1`, model: 'qwen2.5-7b-instruct' })
        const first = await modelsOf(org, p)
        assert.equal(first.models.some(m => m.new), false, 'the first list is the baseline')
        assert.equal(first.currentAvailable, true)
        models.push('qwen3-14b')   // the user loads a new model
        // as if the first look was two hours ago
        const cur = aiStore.get(org).providers.find(x => x.id === p.id)
        const ago = new Date(Date.now() - 2 * 3600e3).toISOString()
        cur.modelsBaseline = ago; cur.knownModels = Object.fromEntries(Object.keys(cur.knownModels).map(k => [k, ago])); aiStore.save(org, { providers: [cur] })
        const second = await modelsOf(org, cur)
        assert.deepEqual(second.models.filter(m => m.new).map(m => m.id), ['qwen3-14b'])
        assert.equal(newCount(aiStore.get(org).providers.find(x => x.id === p.id)), 1)
        assert.equal(aiStore.view(aiStore.get(org).providers[0]).knownModels, undefined, 'the UI gets the count, not the whole history')
        rt.close()
    })
    test('remember: the very first list is never "new"', () => {
        const org = 'org-rem'
        const p = aiStore.addProvider(org, { name: 'x', kind: 'openai', baseUrl: 'http://x/v1', model: 'a' })
        assert.deepEqual(remember(org, p.id, ['a', 'b']), [])
        assert.deepEqual(remember(org, p.id, ['a', 'b', 'c']), ['c'])
    })
})

describe('/api/ai: connect AI (SaaS)', () => {
    let srv, api, owner
    before(async () => {
        srv = await startServer()
        api = client(srv)
        owner = (await api('POST', '/api/auth/register', null, { username: 'connectboss', password: 'secret123', email: 'connectboss@example.com' })).data
    })
    after(() => srv?.stop())

    test('the wizard gets the presets and the Ollama model suggestions', async () => {
        const g = (await api('GET', '/api/ai', owner.token)).data
        assert.ok(g.presets.some(p => p.id === 'vllm') && g.presets.some(p => p.id === 'openrouter'))
        assert.ok(g.ollamaSuggestions.some(s => s.id === 'qwen2.5:7b'))
        assert.equal(g.saas, true)
    })
    test('a cloud preset needs a key; its type comes from the preset', async () => {
        const noKey = await api('POST', '/api/ai/providers', owner.token, { preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-4.5' })
        assert.equal(noKey.status, 400); assert.match(noKey.data.error, /API key/)
        const ok = await api('POST', '/api/ai/providers', owner.token, { preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-haiku-4.5', apiKey: 'sk-or-test' })
        assert.equal(ok.status, 200, JSON.stringify(ok.data))
        assert.equal(ok.data.kind, 'openai'); assert.equal(ok.data.preset, 'openrouter'); assert.equal(ok.data.offline, false); assert.equal(ok.data.hasKey, true)
        assert.equal(ok.data.key, undefined)
        assert.equal(ok.data.qualityCheck, null, 'no quality test unless asked')
        assert.equal((await api('POST', '/api/ai/providers', owner.token, { preset: 'nope', name: 'x', model: 'y' })).status, 400)
    })
    test('an offline preset needs no key — but on KubeEZ Cloud a private address is refused', async () => {
        const lan = await api('POST', '/api/ai/providers', owner.token, { preset: 'lmstudio', name: 'LM Studio', baseUrl: 'http://192.168.1.50:1234/v1', model: 'qwen2.5-7b-instruct' })
        assert.equal(lan.status, 400); assert.match(lan.data.error, /https|private/)
        const d = await api('POST', '/api/ai/discover', owner.token, { preset: 'vllm', baseUrl: 'https://10.0.0.5:8000/v1' })
        assert.equal(d.status, 400); assert.match(d.data.error, /private|internal/)
        const pub = await api('POST', '/api/ai/providers', owner.token, { preset: 'vllm', name: 'vLLM', baseUrl: 'https://gpu.example.invalid/v1', model: 'Qwen/Qwen2.5-14B-Instruct' })
        assert.equal(pub.status, 200, JSON.stringify(pub.data)); assert.equal(pub.data.offline, true); assert.equal(pub.data.hasKey, false)
    })
    test('the quality test starts on its own when asked', async () => {
        const r = await api('POST', '/api/ai/providers', owner.token, { preset: 'other-cloud', name: 'Mine', baseUrl: 'https://llm.example.invalid/v1', model: 'm', apiKey: 'k', qualityCheck: true })
        assert.equal(r.status, 200, JSON.stringify(r.data))
        assert.equal(r.data.qualityCheck, 'started')
        const g = (await api('GET', '/api/ai', owner.token)).data
        assert.equal(g.engines.find(e => e.id === r.data.id).qualityRunning, true)
        await api('POST', '/api/ai/quality/cancel', owner.token)
    })
})

const net = await import('node:net')
const { clusterStore } = await import('../src/services/clusterStore.js')
const { clusterTunnel } = await import('../src/services/clusterTunnel.js')
const { cleanProvider } = await import('../src/routes/ai.js')
describe('a model on the user\'s own network, through one of their clusters', () => {
    let rt, opened = []
    const realOpen = clusterTunnel.open
    before(async () => {
        rt = await fakeRuntime({ kind: 'vllm', models: ['Qwen/Qwen2.5-14B-Instruct'] })
        await clusterStore.saveCluster({ id: 'c-office', clusterName: 'office', orgId: 'org-via', ownerId: 'u', status: 'completed', masterNodes: [{ ip: '10.0.0.10', username: 'root', password: 'x' }], workerNodes: [] })
        // the cluster tunnel: the "office GPU server" 192.168.1.50:8000 is the fake runtime
        clusterTunnel.open = async (cluster, host, port) => {
            opened.push(`${cluster.id}:${host}:${port}`)
            if (host !== '192.168.1.50' || port !== 8000) throw new Error('connect ECONNREFUSED')
            const s = net.connect(Number(new URL(rt.root).port), '127.0.0.1')
            await new Promise((ok, no) => { s.once('connect', ok); s.once('error', no) })
            return s
        }
        process.env.KUBEEZ_MODE = 'saas'   // like KubeEZ Cloud
    })
    after(() => { clusterTunnel.open = realOpen; process.env.KUBEEZ_MODE = 'selfhosted'; rt?.close() })

    test('directly the private address is refused; through the cluster it answers', async () => {
        const direct = await discover({ kind: 'openai', offline: true, baseUrl: 'http://192.168.1.50:8000/v1' }, null)
        assert.equal(direct.ok, false); assert.match(direct.detail, /https|private/)
        opened = []
        const via = await discover({ kind: 'openai', offline: true, baseUrl: 'http://192.168.1.50:8000', viaClusterId: 'c-office' }, null)
        assert.equal(via.ok, true, via.detail)
        assert.equal(via.runtime, 'vLLM'); assert.equal(via.baseUrl, 'http://192.168.1.50:8000/v1')
        assert.deepEqual(via.models.map(m => m.id), ['Qwen/Qwen2.5-14B-Instruct'])
        assert.ok(opened.every(x => x === 'c-office:192.168.1.50:8000') && opened.length >= 2, 'every request is a fresh stream through the cluster')
    })
    test('a saved engine answers through the cluster (text and JSON)', async () => {
        const org = 'org-via'
        const p = aiStore.addProvider(org, { name: 'Office GPU', kind: 'openai', preset: 'vllm', offline: true, baseUrl: 'http://192.168.1.50:8000/v1', model: 'Qwen/Qwen2.5-14B-Instruct', viaClusterId: 'c-office' })
        assert.equal(p.viaClusterId, 'c-office')
        const user = { id: 'u', username: 'u', orgId: org, role: 'admin' }
        const r = await ask(user, { task: 'chat', question: 'What is a DaemonSet?' })
        assert.equal(r.text, 'A DaemonSet runs one pod on every node.')
        assert.equal(r.provider, 'Office GPU')
        const j = await ask(user, { task: 'explain', json: true, question: 'Why does it restart?', validate: (x) => x.summary ? null : 'no summary' })
        assert.equal(j.json.summary, 'The pod runs out of memory.')
        assert.ok(rt.seen.some(s => s.url === '/v1/chat/completions' && s.body.model === 'Qwen/Qwen2.5-14B-Instruct'))
    })
    test('only private addresses, plain http, never the control plane or the cloud metadata service', () => {
        const ok = (u) => cleanProvider({ preset: 'vllm', name: 'GPU', baseUrl: u, model: 'm', viaClusterId: 'c-office' }, ['c-office'])
        assert.equal(ok('http://192.168.1.50:8000/v1').viaClusterId, 'c-office')
        assert.equal(ok('http://gpu-server:1234/v1').baseUrl, 'http://gpu-server:1234/v1')
        assert.equal(ok('http://127.0.0.1:11434').offline, true, 'a model on the control-plane node itself')
        assert.throws(() => ok('https://192.168.1.50/v1'), /plain http/)
        assert.throws(() => ok('http://8.8.8.8/v1'), /public address/)
        assert.throws(() => ok('http://169.254.169.254/latest'), /metadata/)
        assert.throws(() => ok('http://10.0.0.10:6443'), /control plane/)
        assert.throws(() => ok('http://10.0.0.10:22'), /SSH/)
        assert.throws(() => ok('http://example.com/v1'), /IP address on your network/)
    })
    test('only offline runtimes, only the workspace\'s own clusters', () => {
        assert.throws(() => cleanProvider({ preset: 'openrouter', name: 'Cloud',  baseUrl: 'http://10.0.0.5/v1', model: 'm', apiKey: 'k', viaClusterId: 'c-office' }, ['c-office']), /own network/)
        assert.throws(() => cleanProvider({ preset: 'vllm', name: 'GPU',  baseUrl: 'http://10.0.0.5:8000/v1', model: 'm', viaClusterId: 'c-other-org' }, ['c-office']), /your clusters/)
        // switching an existing engine to "directly" checks its address again (refused on KubeEZ Cloud)
        assert.throws(() => cleanProvider({ viaClusterId: '', kind: 'openai', _offline: true, _viaClusterId: 'c-office', _baseUrl: 'http://192.168.1.50:8000/v1' }, ['c-office'], true), /https|private/)
    })
})
