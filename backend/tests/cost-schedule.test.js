// Cost per app (requests × prices, idle money with metrics-server) and
// scheduled hibernate (time zones, overnight wakes, freezes, once per minute)
// — with the API gates.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir, paidOrgs } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
paidOrgs(DATA, ['org-c'])
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([{ id: 'c1', clusterName: 'main', orgId: 'org-c', ownerId: 'c-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.130' }], workerNodes: [] }]))
const costs = await import('../src/services/costs.js')
const hs = await import('../src/services/hibernateSchedule.js')
const { deliveryStore } = await import('../src/services/deliveryStore.js')
after(() => { process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const OUT = ['==KZC:PODS==',
    'shop\tweb-7d9fc8b6c-aaaaa\tReplicaSet\tweb-7d9fc8b6c\t500m,1Gi;100m,256Mi;',
    'shop\tweb-7d9fc8b6c-bbbbb\tReplicaSet\tweb-7d9fc8b6c\t500m,1Gi;100m,256Mi;',
    'shop\tdb-0\tStatefulSet\tdb\t2,4Gi;',
    'dev\tjob-x\tJob\tjob\t,;',
    '==KZC:TOP==',
    'shop web-7d9fc8b6c-aaaaa 100m 300Mi', 'shop web-7d9fc8b6c-bbbbb 120m 310Mi', 'shop db-0 1500m 3Gi',
    '==KZC:END=='].join('\n')

describe('cost per app', () => {
    test('quantities', () => {
        assert.equal(costs.cpu('250m'), 0.25); assert.equal(costs.cpu('2'), 2); assert.equal(costs.cpu(''), 0)
        assert.equal(costs.mem('512Mi'), 0.5); assert.equal(costs.mem('1Gi'), 1); assert.equal(costs.mem('1073741824'), 1); assert.equal(costs.mem('x'), 0)
    })
    test('per app and namespace per month; idle money from real usage; apps without requests named', () => {
        const r = costs.computeCosts(OUT, { currency: 'INR', cpuHour: 2, memGiBHour: 0.5 })
        const web = r.apps.find(a => a.name === 'web')
        assert.equal(web.kind, 'Deployment'); assert.equal(web.pods, 2); assert.equal(web.cpu, 1.2); assert.equal(web.memGiB, 2.5)
        assert.equal(web.monthly, Math.round((1.2 * 2 + 2.5 * 0.5) * 730))
        assert.equal(r.apps[0].name, 'db', 'most expensive first')
        assert.ok(web.idleMonthly > 0 && web.idleMonthly < web.monthly)
        assert.deepEqual(r.noRequests, ['dev/job'])
        assert.equal(r.total, r.namespaces.reduce((s, n) => s + n.monthly, 0)); assert.equal(r.hasUsage, true)
        const scoped = costs.computeCosts(OUT, costs.DEFAULT_RATES, { match: (ns) => ns === 'dev' })
        assert.deepEqual(scoped.namespaces.map(n => n.namespace), ['dev'])
        const noTop = costs.computeCosts(OUT.replace(/==KZC:TOP==[\s\S]*==KZC:END==/, '==KZC:TOP==\n==KZC:END=='))
        assert.equal(noTop.hasUsage, false); assert.equal(noTop.idle, null)
        assert.throws(() => costs.cleanRates({ currency: 'rupees', cpuHour: 1, memGiBHour: 1 }), /Currency/)
        assert.throws(() => costs.cleanRates({ cpuHour: -1, memGiBHour: 1 }), /Prices/)
    })
})

describe('hibernate schedules', () => {
    const s = { id: 's1', clusterId: 'c1', namespace: 'dev', ...hs.cleanSchedule({ clusterId: 'c1', namespace: 'dev', sleep: '21:00', wake: '09:00', timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5] }) }
    test('checked: times, time zone, days', () => {
        assert.deepEqual(s.days, [1, 2, 3, 4, 5])
        for (const b of [{ namespace: 'dev', sleep: '25:00', wake: '09:00' }, { namespace: 'dev', sleep: '09:00', wake: '09:00' }, { namespace: 'dev', sleep: '21:00', wake: '09:00', timezone: 'Mars/Base' }, { namespace: 'dev', sleep: '21:00', wake: '09:00', days: [9] }, { namespace: 'Dev', sleep: '21:00', wake: '09:00' }])
            assert.throws(() => hs.cleanSchedule(b), (e) => e.status === 400, JSON.stringify(b))
    })
    test('due in the schedule\'s time zone; the overnight wake belongs to the day before', () => {
        // Monday 2026-11-02 21:00 IST = 15:30 UTC
        assert.equal(hs.dueAt(s, Date.parse('2026-11-02T15:30:00Z')), 'sleep')
        assert.equal(hs.dueAt(s, Date.parse('2026-11-02T15:31:00Z')), null)
        // Saturday 09:00 IST (after Friday's sleep) wakes; Sunday 09:00 does not; Saturday 21:00 does not sleep
        assert.equal(hs.dueAt(s, Date.parse('2026-11-07T03:30:00Z')), 'wake')
        assert.equal(hs.dueAt(s, Date.parse('2026-11-08T03:30:00Z')), null)
        assert.equal(hs.dueAt(s, Date.parse('2026-11-07T15:30:00Z')), null)
    })
    test('a tick runs what is due once, skips a freeze (with a note), stops when the feature is not usable', async () => {
        hs._test.reset()
        const log = { hib: 0, wake: 0, notify: [], audit: [] }
        const deps = (o = {}) => ({
            schedules: () => [s], clusterOf: async () => ({ id: 'c1', orgId: 'org-c', clusterName: 'main' }),
            usable: () => o.usable ?? true, frozen: () => o.frozen ?? false,
            hibernate: async () => { log.hib++; return { changed: ['Deployment/web 2→0'] } }, wake: async () => { log.wake++; return { changed: [] } },
            notify: (c, ev) => log.notify.push(ev.title), audit: (c, d, ok) => log.audit.push([d, ok])
        })
        const at = Date.parse('2026-11-02T15:30:10Z')
        assert.deepEqual(await hs.tick(deps(), at), ['sleep dev'])
        assert.deepEqual(await hs.tick(deps(), at + 20e3), [], 'once per minute')
        assert.match(log.audit[0][0], /scheduled hibernate dev: Deployment\/web 2→0/)
        hs._test.reset()
        await hs.tick(deps({ frozen: true }), at)
        assert.match(log.notify.at(-1), /Scheduled sleep skipped: dev \(change freeze\)/)
        hs._test.reset()
        await hs.tick(deps({ usable: false }), at)
        assert.equal(log.hib, 1, 'not usable → nothing')
    })
})

describe('API', () => {
    let base, server
    const U = {
        admin: { id: 'c-admin', username: 'cadmin', orgId: 'org-c', role: 'admin' },
        operator: { id: 'c-op', username: 'cop', orgId: 'org-c', role: 'operator' },
        viewer: { id: 'c-view', username: 'cview', orgId: 'org-c', role: 'viewer' },
        scoped: { id: 'c-sc', username: 'csc', orgId: 'org-c', role: 'viewer', clusterAccess: [{ type: 'cluster', clusterId: 'c1', role: 'operator', namespaces: ['team-a'] }] }
    }
    const call = async (who, method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) } }
    before(async () => {
        deliveryStore.saveEnvironment('org-c', { name: 'prod', clusterId: 'c1', namespace: 'prod', protected: true }, { clusterIds: ['c1'] })
        const express = (await import('express')).default
        const app = express(); app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use('/api/delivery', (await import('../src/routes/delivery.js')).default)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())
    const sched = (o) => ({ clusterId: 'c1', namespace: 'dev', sleep: '21:00', wake: '09:00', ...o })

    test('schedules: operators in their namespaces; viewers no; system and protected namespaces admin-only; one per namespace', async () => {
        assert.equal((await call('viewer', 'POST', '/api/delivery/hibernate-schedules', sched())).status, 403)
        assert.equal((await call('operator', 'POST', '/api/delivery/hibernate-schedules', sched())).status, 200)
        assert.equal((await call('operator', 'POST', '/api/delivery/hibernate-schedules', sched())).status, 400, 'one per namespace')
        assert.equal((await call('operator', 'POST', '/api/delivery/hibernate-schedules', sched({ namespace: 'kube-system' }))).status, 403)
        assert.equal((await call('operator', 'POST', '/api/delivery/hibernate-schedules', sched({ namespace: 'prod' }))).status, 403)
        assert.equal((await call('admin', 'POST', '/api/delivery/hibernate-schedules', sched({ namespace: 'prod' }))).status, 200)
        assert.equal((await call('scoped', 'POST', '/api/delivery/hibernate-schedules', sched({ namespace: 'shop' }))).status, 403)
        assert.equal((await call('operator', 'POST', '/api/delivery/hibernate-schedules', sched({ clusterId: 'nope' }))).status, 404)
        assert.deepEqual((await call('scoped', 'GET', '/api/delivery/hibernate-schedules')).data.schedules, [], 'limited members see their namespaces only')
        const all = (await call('operator', 'GET', '/api/delivery/hibernate-schedules')).data.schedules
        assert.equal(all.length, 2)
        assert.equal((await call('viewer', 'DELETE', `/api/delivery/hibernate-schedules/${all[0].id}`)).status, 403)
        assert.equal((await call('operator', 'DELETE', `/api/delivery/hibernate-schedules/${all[0].id}`)).status, 200)
    })
    test('prices: admins set them; everyone reads', async () => {
        assert.equal((await call('viewer', 'GET', '/api/delivery/costs')).data.rates.currency, 'INR')
        assert.equal((await call('operator', 'PUT', '/api/delivery/costs', { currency: 'USD', cpuHour: 0.04, memGiBHour: 0.005 })).status, 403)
        assert.equal((await call('admin', 'PUT', '/api/delivery/costs', { currency: 'USD', cpuHour: 0.04, memGiBHour: 0.005 })).status, 200)
        assert.equal((await call('viewer', 'GET', '/api/delivery/costs')).data.rates.currency, 'USD')
    })
})
