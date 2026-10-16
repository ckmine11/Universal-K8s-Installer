// Claude provider — the official Anthropic SDK. The KubeEZ engine does the
// retries and the fallback to other providers, so the SDK's own retries are off.
import Anthropic from '@anthropic-ai/sdk'
import { AiHttpError } from './http.js'

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5'
// models whose refusals the API can hand to another Claude model itself
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1'])

const clientFor = (key, timeoutMs) => new Anthropic({ apiKey: key, maxRetries: 0, timeout: timeoutMs || 60000 })

function mapError(e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new AiHttpError('Claude rejected the API key', { status: e.status, code: 'AUTH' })
    if (e instanceof Anthropic.NotFoundError) return new AiHttpError(`Claude: ${e.message}`, { status: e.status, code: 'NOT_FOUND' })
    if (e instanceof Anthropic.BadRequestError) return new AiHttpError(`Claude: ${e.message}`, { status: e.status, code: 'BAD_REQUEST' })
    if (e instanceof Anthropic.RateLimitError) return new AiHttpError('Claude rate limit — try again shortly', { status: 429, code: 'RATE_LIMIT', retryable: true })
    if (e instanceof Anthropic.APIConnectionTimeoutError) return new AiHttpError('Claude did not answer in time', { code: 'TIMEOUT', retryable: true })
    if (e instanceof Anthropic.APIConnectionError) return new AiHttpError(`Cannot reach Claude: ${e.message}`, { code: 'NETWORK', retryable: true })
    if (e instanceof Anthropic.APIError) return new AiHttpError(`Claude: ${e.message}`, { status: e.status, code: 'HTTP', retryable: e.status >= 500 || e.status === 408 || e.status === 409 })
    return new AiHttpError(e?.message || String(e), { code: 'ERROR' })
}

export async function anthropicChat(p, key, req) {
    if (!key) throw new AiHttpError('No Claude API key', { code: 'AUTH' })
    const model = p.model || DEFAULT_CLAUDE_MODEL
    const client = clientFor(key, req.timeoutMs)
    const params = {
        model,
        max_tokens: Math.max(256, req.maxTokens || 2000),
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    }
    try {
        const response = FALLBACK_MODELS.has(model)
            // on a policy decline the API re-runs the request on a fitting Claude model itself
            ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
            : await client.messages.create(params)
        if (response.stop_reason === 'refusal') throw new AiHttpError('Claude declined this request', { code: 'REFUSED' })
        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('')
        if (!text) throw new AiHttpError('Claude returned no text', { code: 'EMPTY', retryable: true })
        return { text, model: response.model || model, tokensIn: response.usage?.input_tokens ?? null, tokensOut: response.usage?.output_tokens ?? null }
    } catch (e) {
        throw e instanceof AiHttpError ? e : mapError(e)
    }
}

export async function anthropicHealth(key) {
    if (!key) return { ok: false, detail: 'No API key' }
    try {
        const client = clientFor(key, 10000)
        const models = []
        for await (const m of client.models.list({ limit: 100 })) models.push(m.id)
        return { ok: true, models, detail: `Reachable — ${models.length} model(s)` }
    } catch (e) {
        const m = mapError(e)
        return { ok: false, detail: m.message, code: m.code }
    }
}
