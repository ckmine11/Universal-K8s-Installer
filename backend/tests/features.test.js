// Feature flags: platform (env / superadmin) × workspace (admin); routes
// answer 403 FEATURE_OFF, the GitOps poller and the deploy webhook stop.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prev = { mode: process.env.KUBEEZ_MODE, f: process.env.KUBEEZ_FEATURES, d: process.env.KUBEEZ_FEATURES_DEFAULT }
process.env.KUBEEZ_MODE = 'selfhosted'
delete process.env.KUBEEZ_FEATURES; delete process.env.KUBEEZ_FEATURES_DEFAULT
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([{ id: 'f1', clusterName: 'prod', orgId: 'org-f', ownerId: 'f-admin', k8sVersion: '1.35.0', masterNodes: [{ ip: '192.0.2.99' }], workerNodes: [] }]))
const { features, parseFeatureEnv, FEATURE_KEYS } = await import('../src/services/features.js')
const reset = () => fs.rmSync(path.join(DATA, 'features.json'), { force: true })
after(() => { process.env.KUBEEZ_MODE = prev.mode; if (prev.f !== undefined) process.env.KUBEEZ_FEATURES = prev.f; if (prev.d !== undefined) process.env.KUBEEZ_FEATURES_DEFAULT = prev.d; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('platform and workspace', () => {
    test('on by default; KUBEEZ_FEATURES_DEFAULT=off turns everything off; KUBEEZ_FEATURES picks some', () => {
        reset()
        assert.ok(FEATURE_KEYS.every(k => features.isOn('org-a', k)))
        process.env.KUBEEZ_FEATURES_DEFAULT = 'off'
        try {
            assert.ok(FEATURE_KEYS.every(k => !features.isOn('org-a', k)))
            process.env.KUBEEZ_FEATURES = 'security=on, dora=true, nonsense=on, gitops=maybe'
            assert.equal(features.isOn('org-a', 'security'), true); assert.equal(features.isOn('org-a', 'dora'), true)
            assert.equal(features.isOn('org-a', 'gitops'), false, 'unknown values are ignored')
            assert.deepEqual(parseFeatureEnv('security=on,nonsense=on,helmApps=0'), { security: true, helmApps: false })
        } finally { delete process.env.KUBEEZ_FEATURES_DEFAULT; delete process.env.KUBEEZ_FEATURES }
    })
    test('the superadmin\'s choice wins over the environment; null follows it again', () => {
        reset()
        process.env.KUBEEZ_FEATURES = 'helmApps=off'
        try {
            assert.equal(features.isOn('org-a', 'helmApps'), false)
            features.setPlatform({ helmApps: true }); assert.equal(features.isOn('org-a', 'helmApps'), true)
            features.setPlatform({ helmApps: null }); assert.equal(features.isOn('org-a', 'helmApps'), false)
        } finally { delete process.env.KUBEEZ_FEATURES }
    })
    test('a workspace turns features off for itself only; it cannot turn on what the server has off', () => {
        reset()
        features.setWorkspace('org-a', { hibernate: false, bogus: false, dora: 'no' })
        assert.equal(features.isOn('org-a', 'hibernate'), false); assert.equal(features.isOn('org-b', 'hibernate'), true)
        assert.equal(features.isOn('org-a', 'dora'), true, 'only booleans count')
        features.setPlatform({ debug: false })
        features.setWorkspace('org-a', { debug: true })
        assert.equal(features.isOn('org-a', 'debug'), false)
        const v = features.view('org-a').find(f => f.key === 'debug')
        assert.deepEqual([v.available, v.workspace, v.on], [false, true, false])
        assert.equal(features.isOn('org-a', 'nope'), false)
        assert.throws(() => features.setWorkspace(null, {}), /workspace/)
    })
})

describe('enforcement', () => {
    let base, server
    const U = {
        admin: { id: 'f-admin', username: 'fadmin', orgId: 'org-f', role: 'admin' },
        viewer: { id: 'f-view', username: 'fview', orgId: 'org-f', role: 'viewer' },
        root: { id: 'root', username: 'root', orgId: 'org-root', role: 'superadmin' }
    }
    const call = async (who, method, p, body, headers = {}) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': who } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => null) } }
    before(async () => {
        reset()
        const express = (await import('express')).default
        const app = express(); app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use('/api/features', (await import('../src/routes/features.js')).default)
        app.use('/api/clusters', (await import('../src/routes/clusterReports.js')).default)
        app.use('/api/clusters', (await import('../src/routes/helmApps.js')).default)
        app.use('/api/hooks', (await import('../src/routes/hooks.js')).default)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('admins switch workspace features; viewers read them; only the superadmin changes the server', async () => {
        const v = await call('viewer', 'GET', '/api/features')
        assert.equal(v.status, 200); assert.equal(v.data.canManage, false); assert.equal(v.data.enabled.security, true)
        assert.equal((await call('viewer', 'PUT', '/api/features', { security: false })).status, 403)
        const a = await call('admin', 'PUT', '/api/features', { security: false, helmApps: false })
        assert.equal(a.status, 200); assert.equal(a.data.enabled.security, false)
        assert.equal((await call('admin', 'PUT', '/api/features/platform', { dora: false })).status, 403)
        assert.equal((await call('root', 'PUT', '/api/features/platform', { dora: false })).status, 200)
    })

    test('a feature that is off answers 403 FEATURE_OFF before anything else', async () => {
        const s = await call('viewer', 'GET', '/api/clusters/f1/security')
        assert.equal(s.status, 403); assert.equal(s.data.code, 'FEATURE_OFF'); assert.match(s.data.error, /Settings → Features/)
        const d = await call('viewer', 'GET', '/api/clusters/f1/dora')
        assert.equal(d.status, 403); assert.match(d.data.error, /on this server/)
        assert.equal((await call('admin', 'GET', '/api/clusters/f1/apps')).data.code, 'FEATURE_OFF')
        await call('admin', 'PUT', '/api/features', { security: true })
        assert.notEqual((await call('viewer', 'GET', '/api/clusters/f1/security')).data?.code, 'FEATURE_OFF', 'back on')
        await call('root', 'PUT', '/api/features/platform', { dora: null })
    })

    test('the deploy webhook stops when its workspace turns deploy tokens off', async () => {
        const { apiTokens } = await import('../src/services/apiTokens.js')
        const { token } = apiTokens.create('org-f', { name: 'ci test', clusterId: 'f1', namespace: 'dev', release: 'web', repoId: 'r', chart: 'web' }, { clusterIds: ['f1'], repoIds: ['r'] })
        await call('admin', 'PUT', '/api/features', { deployTokens: false })
        const r = await call(null, 'POST', '/api/hooks/deploy', {}, { authorization: `Bearer ${token}` })
        assert.equal(r.status, 403); assert.equal(r.data.code, 'FEATURE_OFF')
        await call('admin', 'PUT', '/api/features', { deployTokens: true })
    })

    test('GitOps alerts off: the poller does not touch the cluster', async () => {
        const { incidentDetector } = await import('../src/services/incidentDetector.js')
        let calls = 0
        const cluster = { id: 'f1', orgId: 'org-f', clusterName: 'prod' }
        incidentDetector.watched.set('f1', cluster)
        incidentDetector.streams.set('f1', { ssh: { execCommand: async () => { calls++; return { code: 0, stdout: '' } } }, timers: [], failCount: 0, cluster })
        await call('admin', 'PUT', '/api/features', { gitopsAlerts: false })
        await incidentDetector._pollGitops('f1')
        assert.equal(calls, 0)
        await call('admin', 'PUT', '/api/features', { gitopsAlerts: true })
        await incidentDetector._pollGitops('f1')
        assert.equal(calls, 1)
        incidentDetector.stopWatching('f1')
    })
})
