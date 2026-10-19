// Usage and cost per engine: every answer's tokens (as the engine reports them,
// or estimated from the text when it does not) and what they cost at the
// engine's price — per day, kept 100 days. A monthly budget per workspace:
// once it is reached, cloud engines are skipped until the next month (models
// on your own machines keep answering); an alert goes out at 80 % and 100 %.
import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../../utils/paths.js'
import { writeFileAtomicSync } from '../../utils/atomicWrite.js'
import { aiStore } from './aiStore.js'
import { isOffline } from './pricing.js'

const FILE = path.join(DATA_DIR, 'ai-usage.json')
const KEEP_DAYS = 100
export const CURRENCIES = ['$', '₹', '€', '£']
let data = null
const load = () => { if (!data) { try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { data = {} } } return data }
let dirty = null
const persist = () => {
    if (dirty) return
    dirty = setTimeout(() => { dirty = null; try { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(load())) } catch { } }, 2000)
    dirty.unref?.()
}
const day = (t) => new Date(t).toISOString().slice(0, 10)
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4)

/** The workspace's cost settings: budget in its currency, and how many of it make one US$. */
export function costSettings(orgId) {
    const c = aiStore.get(orgId).aiCost || {}
    return { budget: Number(c.budget) || 0, currency: CURRENCIES.includes(c.currency) ? c.currency : '$', perUsd: c.currency && c.currency !== '$' ? (Number(c.perUsd) || 1) : 1 }
}
const money = (usd, c) => { const v = usd * c.perUsd; return `${c.currency}${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}` }

/** One answer. p: the engine; r: { tokensIn, tokensOut, model }; text: { prompt, answer } to estimate from */
export function recordUse(orgId, p, r, text = {}, now = Date.now()) {
    const estimated = r.tokensIn == null || r.tokensOut == null
    const tin = r.tokensIn ?? estimateTokens(text.prompt), tout = r.tokensOut ?? estimateTokens(text.answer)
    const priced = isOffline(p) || (p.priceIn != null && p.priceOut != null)
    const usd = isOffline(p) ? 0 : ((tin * (p.priceIn || 0) + tout * (p.priceOut || 0)) / 1e6)
    const all = load(); const org = all[orgId || '_'] ||= {}
    const d = org[day(now)] ||= {}
    const e = d[p.id] ||= { name: p.name, model: r.model || p.model || null, calls: 0, in: 0, out: 0, usd: 0, estimated: 0, unpriced: 0 }
    Object.assign(e, { name: p.name, model: r.model || p.model || e.model })
    e.calls++; e.in += tin; e.out += tout; e.usd = +(e.usd + usd).toFixed(6)
    if (estimated) e.estimated++
    if (!priced) e.unpriced++
    // older days go
    const cut = day(now - KEEP_DAYS * 86400e3)
    for (const k of Object.keys(org)) if (k < cut) delete org[k]
    persist()
    budgetAlert(orgId, now)
    return { tokensIn: tin, tokensOut: tout, usd, estimated }
}

export function monthUsd(orgId, now = Date.now()) {
    const m = day(now).slice(0, 7)
    let usd = 0
    for (const [k, d] of Object.entries(load()[orgId || '_'] || {})) if (k.startsWith(m)) for (const e of Object.values(d)) usd += e.usd
    return usd
}

/** Is the month's budget used up? (only cloud engines stop) */
export function overBudget(orgId, now = Date.now()) {
    const c = costSettings(orgId)
    return c.budget > 0 && monthUsd(orgId, now) * c.perUsd >= c.budget
}

// 80 % and 100 % of the budget: one alert each a month
function budgetAlert(orgId, now) {
    const c = costSettings(orgId)
    if (!c.budget) return
    const used = monthUsd(orgId, now) * c.perUsd
    const level = used >= c.budget ? 100 : used >= c.budget * 0.8 ? 80 : 0
    if (!level) return
    const key = `${day(now).slice(0, 7)}:${String(level).padStart(3, '0')}`
    const s = aiStore.get(orgId)
    if ((s.budgetAlerted || '') >= key) return
    aiStore.save(orgId, { budgetAlerted: key })
    import('../notifier.js').then(({ notifier }) => notifier.sendTo(orgId, {
        type: 'ai_budget', severity: 'warning', link: '/ai/settings',
        title: level === 100 ? 'AI budget reached — cloud AI engines are paused this month' : 'AI budget 80 % used',
        text: `This month: ${c.currency}${used.toFixed(2)} of ${c.currency}${c.budget.toFixed(2)}.${level === 100 ? ' Models on your own machines keep answering; raise the budget in AI settings → Usage & cost to resume cloud engines.' : ''}`
    })).catch(() => { })
}

/** For AI settings → Usage & cost, and the digest. */
export function usageSummary(orgId, { now = Date.now(), days = 30 } = {}) {
    const c = costSettings(orgId)
    const org = load()[orgId || '_'] || {}
    const month = day(now).slice(0, 7)
    const list = []
    for (let i = days - 1; i >= 0; i--) {
        const k = day(now - i * 86400e3)
        const d = Object.values(org[k] || {})
        list.push({ date: k, calls: d.reduce((a, e) => a + e.calls, 0), tokensIn: d.reduce((a, e) => a + e.in, 0), tokensOut: d.reduce((a, e) => a + e.out, 0), cost: +(d.reduce((a, e) => a + e.usd, 0) * c.perUsd).toFixed(4) })
    }
    const engines = {}
    let calls = 0, tin = 0, tout = 0, usd = 0
    for (const [k, d] of Object.entries(org)) {
        if (!k.startsWith(month)) continue
        for (const [id, e] of Object.entries(d)) {
            const x = engines[id] ||= { id, name: e.name, model: e.model, calls: 0, tokensIn: 0, tokensOut: 0, usd: 0, estimated: 0, unpriced: 0 }
            x.name = e.name; x.model = e.model || x.model
            x.calls += e.calls; x.tokensIn += e.in; x.tokensOut += e.out; x.usd += e.usd; x.estimated += e.estimated || 0; x.unpriced += e.unpriced || 0
            calls += e.calls; tin += e.in; tout += e.out; usd += e.usd
        }
    }
    const providers = Object.fromEntries(aiStore.get(orgId).providers.map(p => [p.id, p]))
    const cost = usd * c.perUsd
    return {
        currency: c.currency, perUsd: c.perUsd, budget: c.budget, budgetText: c.budget ? `${c.currency}${c.budget.toFixed(2)}` : null,
        month: { name: month, calls, tokensIn: tin, tokensOut: tout, cost: +cost.toFixed(4), costText: money(usd, c), pct: c.budget ? Math.min(999, Math.round(cost / c.budget * 100)) : null, over: c.budget > 0 && cost >= c.budget },
        days: list,
        engines: Object.values(engines).map(e => {
            const p = providers[e.id]
            return { ...e, cost: +(e.usd * c.perUsd).toFixed(4), costText: money(e.usd, c), offline: p ? isOffline(p) : null, removed: !p }
        }).sort((a, b) => b.cost - a.cost || b.calls - a.calls)
    }
}

export function _reset() { data = null; if (dirty) { clearTimeout(dirty); dirty = null } }
