// New add-on versions found in the Helm repositories: parsing the repository
// index, which versions are offered (tested vs new), one-line-at-a-time steps,
// what is shown as an update, and the API. The real repositories were checked
// during development; here fixtures stand in for them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import express from 'express'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET = 'test-secret'

const { chartReleases, latestPerLine, kubeRange, discoverFor, addonVersionService, cmpVersion } = await import('../src/services/addonVersions.js')
const { HELM_ADDONS, versionsFor, allVersions } = await import('../src/config/helmAddons.js')
const { buildPlan, availableUpdates, addonSettingsStore } = await import('../src/services/addonSettings.js')

const index = (chart, rows) => `apiVersion: v1\nentries:\n  ${chart}:\n` + rows.map(r => [
    `  - apiVersion: v2`,
    `    appVersion: ${r.app}`,
    ...(r.kube ? [`    kubeVersion: '${r.kube}'`] : []),
    `    created: "2026-10-${r.day || '01'}T00:00:00Z"`,
    ...(r.deprecated ? ['    deprecated: true'] : []),
    `    name: ${chart}`,
    `    urls:`,
    `    - https://example/${chart}-${r.v}.tgz`,
    `    version: ${r.v}`
].join('\n')).join('\n') + `\n  other:\n  - name: other\n    version: 9.9.9\ngenerated: "2026-10-12"\n`

test('repository index: releases, newest stable per version line, Kubernetes range', () => {
    const text = index('kyverno', [
        { v: '3.10.0-rc.1', app: 'v1.20.0-rc.1' }, { v: '3.10.0', app: 'v1.20.0', kube: '>=1.27.0-0' }, { v: '3.9.2', app: 'v1.19.2' },
        { v: '3.9.1', app: 'v1.19.1' }, { v: '3.8.9', app: 'v1.18.9', deprecated: true }
    ])
    const rel = chartReleases(text, 'kyverno')
    assert.equal(rel.length, 5)
    assert.ok(!chartReleases(text, 'kyverno').some(r => r.version === '9.9.9'), 'stops at the next chart')
    assert.deepEqual(latestPerLine(rel).map(r => r.version), ['3.10.0', '3.9.2'], 'no release candidates, no deprecated')
    assert.deepEqual(kubeRange('>=1.27.0-0'), [27, 99])
    assert.deepEqual(kubeRange('>= 1.22.0-0 <1.33.0-0'), [22, 32])
    assert.equal(cmpVersion('v1.10.0', 'v1.9.9') > 0, true)
})

test('discovery: newer lines and newer patches of tested lines; companions follow', () => {
    const k = HELM_ADDONS.kyverno
    const found = discoverFor(k, { 'https://kyverno.github.io/kyverno/': index('kyverno', [
        { v: '3.10.0', app: 'v1.20.0', kube: '>=1.27.0-0' }, { v: '3.9.2', app: 'v1.19.2' }, { v: '3.9.1', app: 'v1.19.1' }, { v: '3.8.2', app: 'v1.18.2' }
    ]) })
    assert.deepEqual(found.map(f => [f.id, f.app, f.tested]), [['3.10.0', 'v1.20.0', false], ['3.9.2', 'v1.19.2', false]])
    assert.deepEqual(found[0].kube, [27, 99])
    assert.deepEqual(found[0].charts, { kyverno: '3.10.0' })
    // Loki + Fluent Bit: the companion chart is its newest release; without it, nothing is offered
    const loki = HELM_ADDONS.loki
    const idx = { 'https://grafana.github.io/helm-charts': index('loki', [{ v: '8.0.0', app: '3.7.0' }]) }
    assert.deepEqual(discoverFor(loki, idx), [], 'Fluent Bit repository missing → nothing')
    idx['https://fluent.github.io/helm-charts'] = index('fluent-bit', [{ v: '0.59.0', app: '5.2.0' }])
    assert.deepEqual(discoverFor(loki, idx)[0].charts, { loki: '8.0.0', 'fluent-bit': '0.59.0' })
    // KubeEZ's own charts and Velero (its storage plugin must match) are not auto-discovered
    assert.deepEqual(discoverFor(HELM_ADDONS.dashboard, idx), [])
})

test('offered versions: new ones listed and marked, recommended stays tested', async () => {
    fs.writeFileSync(`${DATA}/addon-versions.json`, JSON.stringify({ addons: { 'cert-manager': [
        { id: 'v1.22.0', app: 'v1.22.0', charts: { 'cert-manager': 'v1.22.0' }, kube: [22, 99], tested: false },
        { id: 'v1.21.3', app: 'v1.21.3', charts: { 'cert-manager': 'v1.21.3' }, kube: [22, 99], tested: false }
    ] } }))
    const v = versionsFor('cert-manager', 35)
    assert.deepEqual(v.slice(0, 3).map(x => [x.id, x.tested]), [['v1.22.0', false], ['v1.21.3', false], ['v1.21.2', true]])
    assert.equal(v.find(x => x.recommended).id, 'v1.21.2', 'recommended = newest tested')
    // a new version can be applied; one-line-at-a-time knows the new lines
    const cl = { id: 'c-v', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [], addons: {} }
    const p = buildPlan('cert-manager', cl, { version: 'v1.22.0' })
    assert.equal(p.releases[0].version, 'v1.22.0')
    assert.match(p.pre, /in 1\.22\|1\.21\) ;;/)
    assert.ok(allVersions('cert-manager').length > HELM_ADDONS['cert-manager'].versions.length)
})

test('updates: what is newer than what runs, and the next step for one-line-at-a-time add-ons', () => {
    const cl = { id: 'c-u', clusterName: 'prod', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [] }
    const apply = (key, version) => { addonSettingsStore.setPending(cl.id, key, { settings: {}, version }, { by: 't', jobId: `j-${key}` }); addonSettingsStore.finish(cl.id, key, `j-${key}`, { ok: true }) }
    apply('cert-manager', 'v1.20.4')
    apply('kyverno', '3.9.1')
    apply('metrics-server', '3.14.0')
    const u = availableUpdates(cl)
    const cm = u.find(x => x.key === 'cert-manager')
    assert.equal(cm.latest.id, 'v1.22.0')
    assert.equal(cm.latest.tested, false)
    assert.equal(cm.step.id, 'v1.21.3', 'next line first (newest patch of 1.21)')
    assert.equal(u.find(x => x.key === 'kyverno'), undefined, 'kyverno runs the newest')
    assert.equal(u.find(x => x.key === 'metrics-server'), undefined)
    // a version that needs a newer Kubernetes is not offered as an update
    fs.writeFileSync(`${DATA}/addon-versions.json`, JSON.stringify({ addons: { kyverno: [{ id: '3.10.0', app: 'v1.20.0', charts: { kyverno: '3.10.0' }, kube: [40, 99], tested: false }] } }))
    assert.equal(availableUpdates(cl).find(x => x.key === 'kyverno'), undefined)
})

test('check: repositories read, an unreachable one keeps what was found before', async () => {
    fs.writeFileSync(`${DATA}/addon-versions.json`, JSON.stringify({ addons: { kyverno: [{ id: '3.9.9', app: 'v1.19.9', charts: { kyverno: '3.9.9' }, tested: false }] } }))
    const r = await addonVersionService.checkNow({ fetchText: async (url) => {
        if (url.includes('kyverno')) throw new Error('timeout')
        if (url.includes('metallb')) return index('metallb', [{ v: '0.17.0', app: 'v0.17.0' }])
        return 'apiVersion: v1\nentries: {}\n'
    } })
    assert.ok(r.errors.some(e => /kyverno.*timeout/.test(e)))
    assert.deepEqual(addonVersionService.discovered('kyverno').map(x => x.id), ['3.9.9'], 'kept')
    assert.deepEqual(addonVersionService.discovered('metallb').map(x => x.id), ['0.17.0'])
    assert.ok(addonVersionService.lastCheck().at)
})

// ── API ──
let srv, url
before(async () => {
    const { authService } = await import('../src/services/authService.js')
    const { requireAuth } = await import('../src/middleware/authMiddleware.js')
    const { clusterStore } = await import('../src/services/clusterStore.js')
    await clusterStore.saveCluster({ id: 'c-api', clusterName: 'shop', orgId: 'o1', ownerId: 'u1', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.4' }], workerNodes: [] })
    await clusterStore.saveCluster({ id: 'c-other', clusterName: 'theirs', orgId: 'o2', ownerId: 'u9', k8sVersion: '1.35.0', masterNodes: [{ ip: '10.0.0.5' }], workerNodes: [] })
    for (const id of ['c-api', 'c-other']) { addonSettingsStore.setPending(id, 'metallb', { settings: { addresses: '10.0.0.240' }, version: '0.15.3' }, { by: 't', jobId: `j-${id}` }); addonSettingsStore.finish(id, 'metallb', `j-${id}`, { ok: true }) }
    authService.verifyToken = (t) => ({ view: { id: 'u2', username: 'v', role: 'viewer', orgId: 'o1' }, op: { id: 'u3', username: 'o', role: 'operator', orgId: 'o1' } })[t] || null
    authService.getOrgPlan = () => 'PRO'
    const { default: catalog } = await import('../src/routes/addonCatalog.js')
    const app = express(); app.use(express.json()); app.use('/api/addon-catalog', requireAuth, catalog)
    srv = http.createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${srv.address().port}/api/addon-catalog`
})
after(() => { srv?.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

test('API: updates on my clusters only (viewers see them too); check now for operators', async () => {
    let r = await fetch(url + '/updates', { headers: { authorization: 'Bearer view' } })
    const j = await r.json()
    assert.equal(r.status, 200)
    assert.deepEqual(j.updates.map(u => [u.clusterName, u.key]), [['shop', 'metallb']], 'only my workspace')
    assert.ok(j.lastCheck)
    addonVersionService.checkNow = async () => ({ fetchedAt: 'now', errors: [], found: {} })
    r = await fetch(url + '/check-updates', { method: 'POST', headers: { authorization: 'Bearer view' } })
    assert.equal(r.status, 403, 'viewers cannot start a check')
    r = await fetch(url + '/check-updates', { method: 'POST', headers: { authorization: 'Bearer op' } })
    assert.equal(r.status, 200)
})
