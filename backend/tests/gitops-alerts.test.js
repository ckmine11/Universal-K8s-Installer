// GitOps alerts: a sync that keeps failing or an app that stays unhealthy
// becomes an incident (alert, diagnosis with the GitOps status) and clears when
// fixed; the GitOps AI specialist; and "Explain with AI" from the GitOps tab.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
process.env.KUBEEZ_AI_JOB_WAIT_MS = '3000'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'
fs.writeFileSync(path.join(DATA, 'clusters.json'), JSON.stringify([
    // no control-plane saved: anything outside the faked GitOps read fails fast
    { id: 'gc2', clusterName: 'git2', orgId: 'orgG', ownerId: 'g-admin', k8sVersion: '1.35.0', masterNodes: [], workerNodes: [] }
]))

const { incidentDetector } = await import('../src/services/incidentDetector.js')
const { notifier } = await import('../src/services/notifier.js')
const { healingPolicyStore } = await import('../src/services/healingPolicyStore.js')
const { CATALOG } = await import('../src/config/incidentCatalog.js')
const { PLAYBOOKS } = await import('../src/services/remediationEngine.js')
const { SPECIALISTS, pickSpecialist } = await import('../src/services/ai/specialists.js')
const { parseGitops, analyzeGitops, problemOf, gitopsFacts, PERSIST_MS, _test } = await import('../src/services/gitops.js')
after(() => { _test.useConnect(null); incidentDetector.stopWatching('gc1'); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const SHA = '0123456789abcdef0123456789abcdef01234567'
const argo = (name, { sync = 'Synced', health = 'Healthy', op = { phase: 'Succeeded' }, resources = [] } = {}) => ({
    metadata: { name, namespace: 'argocd' },
    spec: { source: { repoURL: 'https://tok:SECRETTOKEN@github.com/acme/deploy.git', path: `apps/${name}`, targetRevision: 'main' }, destination: { server: 'https://kubernetes.default.svc', namespace: 'team-a' } },
    status: { sync: { status: sync, revision: SHA }, health: { status: health }, operationState: op, resources }
})
const ks = (name, { ready = 'True', message = null, suspend = false } = {}) => ({
    metadata: { name, namespace: 'flux-system' }, spec: { targetNamespace: 'team-a', suspend, sourceRef: { kind: 'GitRepository', name: 'repo' } },
    status: { conditions: [{ type: 'Ready', status: ready, message }] }
})
const BAD = {
    ARGO: [
        argo('broken', { sync: 'OutOfSync', health: 'Missing', op: { phase: 'Failed', message: 'ComparisonError: path apps/broken does not exist' } }),
        argo('api', { sync: 'OutOfSync', health: 'Degraded', resources: [{ kind: 'Deployment', namespace: 'team-a', name: 'api', status: 'OutOfSync', health: { status: 'Degraded', message: 'back-off restarting' } }] }),
        argo('drifty', { sync: 'OutOfSync' }),
        argo('fine')
    ],
    KS: [ks('infra', { ready: 'False', message: 'kustomize build failed: missing resource' }), ks('paused', { ready: 'False', message: 'x', suspend: true })],
    HR: [], GITREPO: []
}
const GOOD = { ARGO: ['broken', 'api', 'drifty', 'fine'].map(n => argo(n)), KS: [ks('infra'), ks('paused', { suspend: true })], HR: [], GITREPO: [] }
const output = (parts) => Object.entries(parts).map(([k, v]) => `==KZGITOPS:${k}==\n${typeof v === 'string' ? v : JSON.stringify({ items: v })}`).join('\n') + '\n==KZGITOPS:END=='
const tick = () => new Promise(r => setTimeout(r, 60))

describe('what counts as a GitOps problem', () => {
    const { apps } = parseGitops(output(BAD))
    const by = Object.fromEntries(apps.map(a => [a.name, a]))

    test('one problem per app — the worst; suspended apps are left alone', () => {
        assert.equal(problemOf(by.broken), 'GitOpsSyncFailed')
        assert.equal(problemOf(by.api), 'GitOpsDegraded')
        assert.equal(problemOf(by.drifty), 'GitOpsOutOfSync')
        assert.equal(problemOf(by.infra), 'GitOpsSyncFailed')
        assert.equal(problemOf(by.paused), null)
        assert.equal(problemOf(by.fine), null)
    })

    test('only problems that last: 5 minutes (failed / unhealthy), 30 minutes (out of sync)', () => {
        const now = Date.now()
        assert.deepEqual(analyzeGitops(apps, { since: () => now, now }), [], 'just seen: nothing yet')
        const six = analyzeGitops(apps, { since: () => now - 6 * 60e3, now })
        assert.deepEqual(six.map(f => `${f.reason} ${f.namespace}/${f.target}`).sort(), [
            'GitOpsDegraded argocd/Application/api', 'GitOpsSyncFailed argocd/Application/broken', 'GitOpsSyncFailed flux-system/Kustomization/infra'])
        assert.match(six.find(f => f.target === 'Application/broken').message, /^Argo CD Application argocd\/broken sync failed: ComparisonError: path apps\/broken does not exist$/)
        assert.match(six.find(f => f.target === 'Application/api').message, /degraded after sync — Deployment api: back-off restarting/)
        const later = analyzeGitops(apps, { since: () => now - PERSIST_MS.GitOpsOutOfSync - 1, now })
        assert.ok(later.some(f => f.reason === 'GitOpsOutOfSync' && f.target === 'Application/drifty'))
    })

    test('the facts for the diagnosis and the AI carry no credentials', () => {
        const t = gitopsFacts(by.api)
        assert.match(t, /Argo CD Application argocd\/api/); assert.match(t, /Sync: OutOfSync, health: Degraded/); assert.match(t, /Deployment team-a\/api: OutOfSync, Degraded, back-off restarting/)
        assert.equal(t.includes('SECRETTOKEN'), false)
    })

    test('catalogued with a diagnose playbook; out-of-sync is off by default (manual sync is often on purpose)', () => {
        for (const r of ['GitOpsSyncFailed', 'GitOpsDegraded', 'GitOpsOutOfSync']) {
            assert.equal(CATALOG[r].category, 'gitops'); assert.equal(CATALOG[r].fixable, false)
            assert.equal(typeof PLAYBOOKS[r].diagnose, 'function')
        }
        assert.equal(CATALOG.GitOpsSyncFailed.policy, 'notify'); assert.equal(CATALOG.GitOpsOutOfSync.policy, 'off')
    })
})

describe('the detector: incident, alert, diagnosis, cleared when fixed', () => {
    const cluster = { id: 'gc1', clusterName: 'git', orgId: 'orgG', ownerId: 'g-admin', masterNodes: [{ ip: '192.0.2.50', username: 'root', password: 'x' }] }
    let answer = output(BAD), calls = 0
    const alerts = []
    const origEmit = notifier.emit.bind(notifier)
    const age = (min) => { for (const k of incidentDetector.firstSeen.keys()) if (k.startsWith('gc1|gitops|')) incidentDetector.firstSeen.set(k, Date.now() - min * 60e3) }
    const open = () => incidentDetector.getIncidents().filter(i => i.clusterId === 'gc1' && i.category === 'gitops' && !['resolved', 'cleared'].includes(i.status))

    before(() => {
        notifier.emit = (orgId, ev) => { if (orgId === 'orgG') alerts.push(ev) }
        incidentDetector.watched.set('gc1', cluster)
        incidentDetector.streams.set('gc1', { ssh: { execCommand: async (cmd) => { calls++; return { code: 0, stdout: /KZGITOPS/.test(cmd) ? answer : '==END==' } } }, timers: [], failCount: 0, cluster })
    })
    after(() => { notifier.emit = origEmit })

    test('first sight: clocks start, no incident yet', async () => {
        await incidentDetector._pollGitops('gc1')
        assert.equal(open().length, 0)
        assert.ok([...incidentDetector.firstSeen.keys()].some(k => k === 'gc1|gitops|Application/argocd/broken|GitOpsSyncFailed'))
    })

    test('the health poller does not reset the GitOps clocks', async () => {
        await incidentDetector._pollHealth('gc1')
        assert.ok(incidentDetector.firstSeen.has('gc1|gitops|Application/argocd/broken|GitOpsSyncFailed'))
    })

    test('after 5 minutes: incidents with an alert each; diagnosis carries the GitOps status', async () => {
        age(6)
        await incidentDetector._pollGitops('gc1')
        await tick()
        const list = open()
        assert.deepEqual(list.map(i => `${i.reason} ${i.namespace}/${i.target}`).sort(), [
            'GitOpsDegraded argocd/Application/api', 'GitOpsSyncFailed argocd/Application/broken', 'GitOpsSyncFailed flux-system/Kustomization/infra'])
        const broken = list.find(i => i.target === 'Application/broken')
        assert.equal(broken.severity, 'warning'); assert.equal(broken.orgId, 'orgG')
        assert.ok(alerts.some(a => a.type === 'incident' && /GitOps sync failed/.test(a.title) && /path apps\/broken does not exist/.test(a.text)), JSON.stringify(alerts.map(a => a.title)))
        assert.equal(broken.status, 'unresolved')
        assert.match(broken.details, /Fix it in Git/)
        const ev = (broken.evidence || []).find(e => e.title === 'GitOps status')
        assert.ok(ev, 'evidence attached'); assert.match(ev.text, /ComparisonError/); assert.equal(ev.text.includes('SECRETTOKEN'), false)
    })

    test('the same problem again: one incident, counted', async () => {
        await incidentDetector._pollGitops('gc1')
        assert.equal(open().length, 3)
        assert.equal(open().find(i => i.target === 'Application/broken').count, 2)
    })

    test('out of sync only when the workspace turns it on (30 minutes)', async () => {
        healingPolicyStore.savePolicies('orgG', { GitOpsOutOfSync: 'notify' })
        try {
            age(31)
            await incidentDetector._pollGitops('gc1')
            assert.ok(open().some(i => i.reason === 'GitOpsOutOfSync' && i.target === 'Application/drifty'))
        } finally { healingPolicyStore.savePolicies('orgG', {}) }
    })

    test('a tool that cannot be read keeps its incidents as they are', async () => {
        const before = open().length
        answer = output({ ARGO_ERR: 'Error from server (Forbidden): applications.argoproj.io is forbidden', KS: GOOD.KS, HR: [], GITREPO: [] })
        await incidentDetector._pollGitops('gc1')
        assert.equal(open().length, before)
    })

    test('fixed in Git: incidents clear and a "Cleared" alert goes out', async () => {
        answer = output(GOOD)
        alerts.length = 0
        await incidentDetector._pollGitops('gc1')
        assert.equal(open().length, 0)
        assert.ok(alerts.some(a => a.type === 'incident_resolved' && /Cleared: GitOps sync failed/.test(a.title)))
        assert.equal([...incidentDetector.firstSeen.keys()].some(k => k.startsWith('gc1|gitops|')), false, 'clocks of gone problems are dropped')
    })

    test('no Argo CD and no Flux: asked again only every ~30 minutes', async () => {
        answer = output({ ARGO_ERR: 'doesn\'t have a resource type', KS_ERR: 'doesn\'t have a resource type', HR_ERR: 'doesn\'t have a resource type', GITREPO_ERR: 'x' })
        await incidentDetector._pollGitops('gc1')
        const n = calls
        for (let i = 0; i < 10; i++) await incidentDetector._pollGitops('gc1')
        assert.equal(calls, n, 'skipped')
        await incidentDetector._pollGitops('gc1')
        assert.equal(calls, n + 1)
    })
})

describe('the GitOps AI specialist', () => {
    test('picked for GitOps incidents', () => {
        assert.equal(pickSpecialist({ category: 'gitops', reason: 'GitOpsSyncFailed', message: 'dial tcp: i/o timeout' }), 'gitops')
        assert.equal(pickSpecialist({ category: 'pod', reason: 'CrashLoopBackOff', message: '' }), 'app')
    })

    test('reads status, events and the controller log — read-only, never Secrets; refuses odd names', async () => {
        const cmds = []
        const run = async (label, cmd) => { cmds.push(cmd) }
        await SPECIALISTS.gitops.collect(run, { target: 'Application/broken', namespace: 'argocd' })
        assert.ok(cmds.some(c => /get applications\.argoproj\.io broken -o jsonpath/.test(c)))
        assert.ok(cmds.some(c => /logs statefulset\/argocd-application-controller/.test(c)))
        assert.ok(cmds.some(c => /get events --field-selector involvedObject\.name=broken/.test(c)))
        cmds.length = 0
        await SPECIALISTS.gitops.collect(run, { target: 'Kustomization/infra', namespace: 'flux-system' })
        assert.ok(cmds.some(c => /get kustomizations\.kustomize\.toolkit\.fluxcd\.io infra/.test(c)))
        for (const c of cmds) { assert.equal(/\bsecrets?\b/i.test(c), false, c); assert.equal(/\b(patch|annotate|apply|delete|edit)\b/.test(c), false, c) }
        cmds.length = 0
        await SPECIALISTS.gitops.collect(run, { target: 'Application/x;reboot', namespace: 'argocd' })
        await SPECIALISTS.gitops.collect(run, { target: 'Secret/x', namespace: 'argocd' })
        assert.equal(cmds.length, 0)
        assert.match(SPECIALISTS.gitops.prompt, /never suggest editing the live objects/)
    })
})

describe('API: Explain with AI from the GitOps tab', () => {
    let base, server
    const U = {
        admin: { id: 'g-admin', username: 'gadmin', orgId: 'orgG', role: 'admin' },
        operator: { id: 'g-op', username: 'gop', orgId: 'orgG', role: 'operator' },
        operatorAi: { id: 'g-op2', username: 'gop2', orgId: 'orgG', role: 'operator', aiAccess: 'ask' },
        scopedAi: { id: 'g-sc', username: 'gsc', orgId: 'orgG', role: 'viewer', aiAccess: 'ask', clusterAccess: [{ type: 'cluster', clusterId: 'gc2', role: 'viewer', namespaces: ['team-b'] }] },
        stranger: { id: 'g-x', username: 'gx', orgId: 'orgX', role: 'admin' }
    }
    const call = async (who, body) => {
        const r = await fetch(`${base}/api/ai/explain/gitops/gc2`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': who }, body: JSON.stringify(body) })
        return { status: r.status, data: await r.json().catch(() => null) }
    }
    before(async () => {
        const express = (await import('express')).default
        const { default: router } = await import('../src/routes/aiOps.js')
        _test.useConnect(async () => ({ execCommand: async () => ({ stdout: output(BAD) }), dispose() { } }))
        const app = express()
        app.use(express.json())
        app.use((req, res, next) => { req.user = U[req.get('x-test-user')]; next() })
        app.use('/api/ai', router)
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
        base = `http://127.0.0.1:${server.address().port}`
    })
    after(() => server?.close())

    test('needs ai:use; another workspace does not see the cluster', async () => {
        const r = await call('operator', { kind: 'Application', namespace: 'argocd', name: 'broken' })
        assert.equal(r.status, 403); assert.equal(r.data.requiredPermission, 'ai:use')
        assert.equal((await call('stranger', { kind: 'Application', namespace: 'argocd', name: 'broken' })).status, 404)
    })

    test('checked before any AI call: bad names 400, unknown 404, healthy 409, outside your namespaces 404', async () => {
        assert.equal((await call('operatorAi', { kind: 'Application', namespace: 'argocd', name: 'x;reboot' })).status, 400)
        assert.equal((await call('operatorAi', { kind: 'Secret', namespace: 'argocd', name: 'x' })).status, 400)
        assert.equal((await call('operatorAi', { kind: 'Application', namespace: 'argocd', name: 'ghost' })).status, 404)
        const fine = await call('operatorAi', { kind: 'Application', namespace: 'argocd', name: 'fine' })
        assert.equal(fine.status, 409); assert.match(fine.data.error, /nothing to explain/)
        assert.equal((await call('scopedAi', { kind: 'Application', namespace: 'argocd', name: 'broken' })).status, 404, 'deploys to team-a, member is limited to team-b')
    })

    test('a real problem reaches the explainer (here: AI is off for the workspace)', async () => {
        const r = await call('operatorAi', { kind: 'Application', namespace: 'argocd', name: 'broken' })
        assert.ok([400, 503].includes(r.status), JSON.stringify(r.data))
        assert.ok(['AI_OFF', 'AI_UNAVAILABLE'].includes(r.data.code), JSON.stringify(r.data))
    })

    test('with a model: the GitOps specialist and the facts go in (masked), the answer comes back without a fix button', async () => {
        const { aiStore } = await import('../src/services/ai/aiStore.js')
        const seen = []
        const model = http.createServer((req, res) => {
            let b = ''; req.on('data', c => b += c); req.on('end', () => {
                seen.push(b)
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Argo CD cannot find apps/broken in the repo', cause: 'the path apps/broken does not exist at main', evidence: ['ComparisonError: path apps/broken does not exist'], fix: ['Fix spec.source.path in Git or add the folder', 'Sync now'], action: null, confidence: 'high' }) } }] }))
            })
        })
        await new Promise(r => model.listen(0, '127.0.0.1', r))
        try {
            aiStore.addProvider('orgG', { name: 'Fake', kind: 'ollama', baseUrl: `http://127.0.0.1:${model.address().port}`, model: 'm' })
            const r = await call('operatorAi', { kind: 'Application', namespace: 'argocd', name: 'broken', fresh: true })
            assert.equal(r.status, 200, JSON.stringify(r.data))
            assert.equal(r.data.answer.summary, 'Argo CD cannot find apps/broken in the repo')
            assert.deepEqual(r.data.answer.evidence, ['ComparisonError: path apps/broken does not exist'], 'proof is checked against the real data')
            assert.equal(r.data.answer.action ?? null, null); assert.equal(r.data.canAct, false)
            const sent = seen.join('\n')
            assert.match(sent, /Argo CD and Flux expert/)
            assert.match(sent, /GitOpsSyncFailed/)
            assert.match(sent, /Argo CD Application argocd\/broken/)
            assert.equal(sent.includes('SECRETTOKEN'), false, 'repo credentials never reach the model')
        } finally { model.closeAllConnections?.(); model.close() }
    })
})
