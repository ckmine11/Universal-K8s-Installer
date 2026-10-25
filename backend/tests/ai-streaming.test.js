// Ask AI answers like Claude / ChatGPT: Claude and Gemini stream the answer as
// it is written (fake servers speak each API's real stream format), general
// questions skip the live cluster read, and the chat instructions ask for full,
// well-structured answers.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET ||= 'test-secret'

const { anthropicChat } = await import('../src/services/ai/anthropic.js')
const { chat, _setGeminiBaseForTests } = await import('../src/services/ai/providers.js')
const { isGeneralQuestion, CHAT_SYSTEM } = await import('../src/services/ai/chatops.js')

const seen = []   // { path, headers, body } of every request
const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`)
    res.end()
}
const claudeEvents = (model, pieces, stop = 'end_turn') => [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...pieces.map(t => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } }],
    ['message_stop', { type: 'message_stop' }]
]

let server
before(async () => {
    server = http.createServer((req, res) => {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
            const j = body ? JSON.parse(body) : {}
            seen.push({ path: req.url, headers: req.headers, body: j })
            if (req.url.startsWith('/v1/messages')) {
                if (String(j.messages?.[0]?.content).includes('REFUSE')) return sse(res, claudeEvents(j.model, [], 'refusal'))
                return sse(res, claudeEvents(j.model, ['A **Pod** is ', 'the smallest ', 'unit in Kubernetes.']))
            }
            if (req.url.includes(':streamGenerateContent')) {
                return sse(res, [
                    [null, { candidates: [{ content: { parts: [{ text: 'A DaemonSet ' }] } }] }],
                    [null, { candidates: [{ content: { parts: [{ text: 'runs one pod per node.' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 7 }, modelVersion: 'gemini-2.5-flash' }]
                ])
            }
            res.writeHead(404); res.end()
        })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`
    _setGeminiBaseForTests(`http://127.0.0.1:${server.address().port}`)
})
after(() => { server.close(); delete process.env.ANTHROPIC_BASE_URL; _setGeminiBaseForTests(null) })

test('Claude streams: the answer grows piece by piece, then the full text and token counts', async () => {
    const parts = []
    const r = await anthropicChat({ model: 'claude-sonnet-4-6' }, 'sk-test', { system: 'sys', messages: [{ role: 'user', content: 'what is a pod?' }], maxTokens: 8000, onToken: (all) => parts.push(all) })
    assert.deepEqual(parts, ['A **Pod** is ', 'A **Pod** is the smallest ', 'A **Pod** is the smallest unit in Kubernetes.'])
    assert.equal(r.text, 'A **Pod** is the smallest unit in Kubernetes.')
    assert.equal(r.tokensIn, 12); assert.equal(r.tokensOut, 9)
    const req = seen.at(-1)
    assert.equal(req.body.stream, true); assert.equal(req.body.max_tokens, 8000)
    assert.equal(req.body.fallbacks, undefined, 'no fallback for a model without it')
})

test('Claude Opus 5.5 streams with the server-side fallback; the default model is Opus 5.5', async () => {
    const r = await anthropicChat({}, 'sk-test', { messages: [{ role: 'user', content: 'hi' }], onToken: () => { } })
    assert.match(r.text, /smallest unit/)
    const req = seen.at(-1)
    assert.equal(req.body.model, 'claude-opus-5-5')
    assert.equal(req.body.fallbacks, 'default')
    assert.match(String(req.headers['anthropic-beta']), /server-side-fallback-2026-07-01/)
})

test('a Claude refusal is reported, not shown as an empty answer', async () => {
    await assert.rejects(anthropicChat({ model: 'claude-opus-5-5' }, 'sk-test', { messages: [{ role: 'user', content: 'REFUSE' }], onToken: () => { } }), (e) => e.code === 'REFUSED')
})

test('Gemini streams too', async () => {
    const parts = []
    const r = await chat({ kind: 'gemini', model: 'gemini-2.5-flash' }, 'g-key', { messages: [{ role: 'user', content: 'what is a daemonset?' }], maxTokens: 8000, onToken: (all) => parts.push(all) })
    assert.deepEqual(parts, ['A DaemonSet ', 'A DaemonSet runs one pod per node.'])
    assert.equal(r.text, 'A DaemonSet runs one pod per node.')
    assert.equal(r.tokensIn, 20); assert.equal(r.tokensOut, 7)
    assert.equal(seen.at(-1).headers['x-goog-api-key'], 'g-key')
})

test('general questions go straight to the AI; questions about the clusters read them live', () => {
    const clusters = [{ clusterName: 'shop-prod' }]
    for (const q of ['what is a daemonset?', 'explain kubernetes networking', 'How do I write a Helm chart for nginx?', 'difference between deployment and statefulset', 'kubernetes me ingress kya hota hai', 'helm chart kaise banaye'])
        assert.equal(isGeneralQuestion(q, clusters), true, q)
    for (const q of ['how many pods are running?', 'why is my pod crashing?', 'what is wrong with the cluster', 'show logs of web-2', 'what is the status of shop-prod', 'how do I fix my failing deployment', 'mere pods kya hai', 'shop-prod me kitne pods hai'])
        assert.equal(isGeneralQuestion(q, clusters), false, q)
})

test('the chat instructions ask for complete, structured answers (no "short", no "no tables")', () => {
    assert.match(CHAT_SYSTEM, /Markdown/)
    assert.match(CHAT_SYSTEM, /tables/)
    assert.match(CHAT_SYSTEM, /fenced code blocks/)
    assert.doesNotMatch(CHAT_SYSTEM, /short and to the point|no tables/)
})
