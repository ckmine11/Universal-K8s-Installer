// Every AI engine works without settings: KubeEZ learns from an engine's own
// error what it does not accept (and remembers it) — GPT-5 / o-series want
// max_completion_tokens and no temperature, small local models cap the answer
// length, some servers cannot stream, older Claude models have a lower output
// ceiling. A fake OpenAI-compatible server plays each kind of engine.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { tempDataDir } from './helpers/server.js'

process.env.KUBEEZ_DATA_DIR = tempDataDir()
process.env.APP_SECRET ||= 'test-secret'

const { chat, _resetQuirks } = await import('../src/services/ai/providers.js')
const { anthropicChat } = await import('../src/services/ai/anthropic.js')

const calls = []
const bad = (res, message, status = 400) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } })) }
const ok = (res, j, text) => {
    if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const piece of text.match(/.{1,6}/g)) res.write(`data: ${JSON.stringify({ model: j.model, choices: [{ delta: { content: piece } }] })}\n\n`)
        res.write('data: [DONE]\n\n'); return res.end()
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ model: j.model, choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 4 } }))
}

let server, base
before(async () => {
    server = http.createServer((req, res) => {
        let body = ''
        req.on('data', d => body += d)
        req.on('end', () => {
            const j = body ? JSON.parse(body) : {}
            calls.push({ url: req.url, body: j })
            if (req.url.startsWith('/v1/messages')) {   // Claude 3 Haiku: at most 4096 output tokens
                if (j.max_tokens > 4096) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${j.max_tokens} > 4096, which is the maximum allowed number of output tokens for claude-3-haiku-20240307` } })) }
                res.writeHead(200, { 'content-type': 'application/json' })
                return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'haiku answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }))
            }
            switch (j.model) {
                case 'gpt-5-mini':   // a reasoning model: known up front
                case 'acme-reasoner':  // the same rules, learned from its errors
                    if ('max_tokens' in j) return bad(res, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.")
                    if ('temperature' in j) return bad(res, "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.")
                    return ok(res, j, 'reasoned answer')
                case 'tiny-local':   // a 4K-context local model
                    if ((j.max_tokens || 0) + 900 > 4096) return bad(res, `This model's maximum context length is 4096 tokens. However, you requested ${j.max_tokens + 900} tokens (900 in the messages, ${j.max_tokens} in the completion).`)
                    return ok(res, j, 'small but fine')
                case 'no-stream':    // a server without streaming
                    if (j.stream) return bad(res, 'stream is not supported by this server', 501)
                    return ok(res, j, 'whole answer at once')
                default: return ok(res, j, 'plain answer')
            }
        })
    })
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
    process.env.ANTHROPIC_BASE_URL = base
})
after(() => { server.close(); delete process.env.ANTHROPIC_BASE_URL })
beforeEach(() => { calls.length = 0; _resetQuirks() })

const engine = (model) => ({ kind: 'openai', baseUrl: `${base}/v1`, model })
const ask = (model, extra = {}) => chat(engine(model), 'k', { system: 's', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8000, ...extra })

test('GPT-5 / o-series: max_completion_tokens and no temperature from the first request', async () => {
    const parts = []
    const r = await ask('gpt-5-mini', { onToken: (t) => parts.push(t) })
    assert.equal(r.text, 'reasoned answer'); assert.ok(parts.length > 1, 'streamed')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.max_completion_tokens, 8000); assert.ok(!('temperature' in calls[0].body))
})

test('an unknown model with the same rules: learned from its errors, remembered', async () => {
    assert.equal((await ask('acme-reasoner')).text, 'reasoned answer')
    assert.equal(calls.length, 3, 'max_tokens refused, then temperature refused, then answered')
    calls.length = 0
    assert.equal((await ask('acme-reasoner')).text, 'reasoned answer')
    assert.equal(calls.length, 1, 'remembered: right the first time')
})

test('a small local model: the answer length is lowered to fit its context', async () => {
    const r = await ask('tiny-local', { onToken: () => { } })
    assert.equal(r.text, 'small but fine')
    assert.equal(calls.at(-1).body.max_tokens, 4096 - 900 - 64, 'what is left of its context')
})

test('a server that cannot stream answers in one piece (and the page still gets it)', async () => {
    const parts = []
    const r = await ask('no-stream', { onToken: (t) => parts.push(t) })
    assert.equal(r.text, 'whole answer at once')
    assert.deepEqual(parts, ['whole answer at once'])
    calls.length = 0
    await ask('no-stream', { onToken: () => { } })
    assert.equal(calls.length, 1, 'remembered: no stream attempt the second time')
})

test('an ordinary OpenAI-compatible engine is unchanged: max_tokens, temperature, stream', async () => {
    const r = await ask('llama-3.3-70b', { onToken: () => { } })
    assert.equal(r.text, 'plain answer')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.max_tokens, 8000); assert.equal(calls[0].body.temperature, 0.2); assert.equal(calls[0].body.stream, true)
})

test('an older Claude model with a 4096-token ceiling: asked again within it', async () => {
    const r = await anthropicChat({ model: 'claude-3-haiku-20240307' }, 'sk-test', { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8000 })
    assert.equal(r.text, 'haiku answer')
    assert.deepEqual(calls.map(c => c.body.max_tokens), [8000, 4096])
})
