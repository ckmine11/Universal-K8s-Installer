// Plans: Free and Pro limits, the Pro trial of a new hosted workspace (Pro while
// it runs, Free after), and GET /api/billing/plan — what a workspace can use.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, client } from './helpers/server.js'
import { PLAN_LIMITS, newSubscription, effectiveSubscription } from '../src/services/plans.js'
import { FEATURES } from '../src/services/features.js'

const DAY = 864e5

describe('plan rules', () => {
    test('Free: 1 cluster, 5 nodes, 1 member; older Free accounts saved with less get the new limits', () => {
        assert.deepEqual(PLAN_LIMITS.FREE, { maxClusters: 1, maxNodes: 5, maxMembers: 1 })
        const old = effectiveSubscription({ plan: 'FREE', maxClusters: 1, maxNodes: 2, maxMembers: 1 })
        assert.deepEqual([old.plan, old.maxClusters, old.maxNodes, old.maxMembers, old.trial], ['FREE', 1, 5, 1, null])
        // an admin who gave a Free workspace more keeps it
        assert.equal(effectiveSubscription({ plan: 'FREE', maxClusters: 3 }).maxClusters, 3)
    })

    test('a trial is Pro with Pro limits while it runs, Free after; paid plans are as stored', () => {
        const now = Date.parse('2026-11-05T10:00:00Z')
        const sub = newSubscription({ now, days: 14 })
        assert.equal(sub.plan, 'FREE'); assert.equal(sub.trialEndsAt, '2026-11-19T10:00:00.000Z')
        const during = effectiveSubscription(sub, now + 3 * DAY)
        assert.deepEqual([during.plan, during.maxClusters, during.maxNodes, during.maxMembers], ['PRO', 10, 50, 5])
        assert.deepEqual(during.trial, { endsAt: sub.trialEndsAt, daysLeft: 11 })
        const afterEnd = effectiveSubscription(sub, now + 15 * DAY)
        assert.deepEqual([afterEnd.plan, afterEnd.maxClusters, afterEnd.maxNodes, afterEnd.trial], ['FREE', 1, 5, { endedAt: sub.trialEndsAt }])
        assert.equal(newSubscription({ days: 0 }).trialEndsAt, undefined, 'KUBEEZ_TRIAL_DAYS=0: no trial')
        assert.equal(newSubscription({ trial: false }).trialEndsAt, undefined)
        const pro = effectiveSubscription({ plan: 'pro', maxClusters: 10, trialEndsAt: new Date(now + DAY).toISOString() }, now)
        assert.deepEqual([pro.plan, pro.trial], ['PRO', null], 'a paid plan is not a trial')
    })

    test('Free has what one person needs for one cluster; Pro adds alerts, guards, pipelines, scale', () => {
        const free = Object.entries(FEATURES).filter(([, f]) => (f.plan || 'free') === 'free').map(([k]) => k).sort()
        assert.deepEqual(free, ['appMetrics', 'certManager', 'costs', 'debug', 'dora', 'gitops', 'gitopsCreate', 'helmApps', 'helmDrift', 'hibernate', 'registries', 'security'])
        for (const [k, f] of Object.entries(FEATURES)) assert.ok(['free', 'pro', undefined].includes(f.plan), `${k}: never Enterprise-only`)
    })

    test('every add-on a Free feature needs is a Free add-on (and the console lists the same)', async () => {
        const { FREE_ADDONS, checkAddonPlan } = await import('../src/config/addonTiers.js')
        // explorer, ingress: basics · cert-manager → Certificates · trivy-operator → Security · argocd / flux → GitOps
        for (const k of ['dashboard', 'metrics-server', 'kubeez-ai', 'explorer', 'ingress', 'cert-manager', 'trivy-operator', 'argocd', 'flux']) assert.ok(FREE_ADDONS.includes(k), k)
        assert.equal(checkAddonPlan({ monitoring: true }, 'FREE').allowed, false, 'production stacks stay Pro')
        assert.equal(checkAddonPlan({ monitoring: true }, 'PRO').allowed, true)
        const ui = fs.readFileSync(new URL('../../frontend/src/config/addons.js', import.meta.url), 'utf8')
        const uiFree = [...ui.matchAll(/key: '([^']+)'[\s\S]*?tier: '(free|pro)'/g)].filter(m => m[2] === 'free').map(m => m[1]).sort()
        assert.deepEqual(uiFree, [...FREE_ADDONS].sort())
    })
})

describe('the trial on a real server, and GET /api/billing/plan', () => {
    let server, api, trialOwner
    before(async () => {
        server = await startServer({ KUBEEZ_TRIAL_DAYS: '14' })
        api = client(server)
        trialOwner = (await api('POST', '/api/auth/register', null, { username: 'trialist', password: 'secret123', email: 'trialist@example.com' })).data
    })
    after(() => server?.stop())

    test('a new workspace starts in a 14-day Pro trial: Pro features and Pro limits', async () => {
        const p = await api('GET', '/api/billing/plan', trialOwner.token)
        assert.equal(p.status, 200, JSON.stringify(p.data))
        assert.equal(p.data.plan, 'PRO'); assert.equal(p.data.trial.daysLeft, 14)
        assert.deepEqual(p.data.limits, { clusters: 10, nodes: 50, members: 5 })
        assert.deepEqual(p.data.usage, { clusters: 0, nodes: 0, members: 1 })
        assert.ok(p.data.features.every(f => f.included), 'every feature during the trial')
        assert.ok(p.data.capabilities.every(c => c.included), 'every paid capability during the trial')
        assert.equal((await api('GET', '/api/delivery/tokens', trialOwner.token)).status, 200, 'a Pro list opens')
        const lic = await api('GET', '/api/license/status', trialOwner.token)
        assert.match(lic.data.plan, /^Pro trial — 14 days left$/)
    })

})

describe('a Free workspace (no trial): GET /api/billing/plan shows what is in and what is Pro', () => {
    let server, api, owner
    before(async () => {
        server = await startServer()   // KUBEEZ_TRIAL_DAYS=0
        api = client(server)
        owner = (await api('POST', '/api/auth/register', null, { username: 'freebie', password: 'secret123', email: 'freebie@example.com' })).data
    })
    after(() => server?.stop())

    test('Free limits; Free features included, Pro ones and paid capabilities not; their lists answer 402', async () => {
        const p = await api('GET', '/api/billing/plan', owner.token)
        assert.equal(p.status, 200, JSON.stringify(p.data))
        assert.deepEqual([p.data.plan, p.data.trial], ['FREE', null])
        assert.deepEqual(p.data.limits, { clusters: 1, nodes: 5, members: 1 })
        const inc = (k) => p.data.features.find(f => f.key === k)?.included
        for (const k of ['registries', 'gitopsCreate', 'debug', 'helmDrift', 'helmApps', 'security']) assert.equal(inc(k), true, k)
        for (const k of ['previews', 'deployTokens', 'cveGate', 'certAlerts', 'rollouts']) assert.equal(inc(k), false, k)
        assert.ok(p.data.capabilities.length >= 8 && p.data.capabilities.every(c => !c.included && c.plan === 'pro'))
        assert.equal((await api('GET', '/api/delivery/registries', owner.token)).status, 200, 'registries are Free now')
        const t = await api('GET', '/api/delivery/tokens', owner.token)
        assert.equal(t.status, 402); assert.equal(t.data.code, 'UPGRADE_REQUIRED')
        assert.equal((await api('GET', '/api/billing/plan')).status, 401)
    })
})
