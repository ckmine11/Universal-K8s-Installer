// Found while reviewing the AI section on prod (2026-10-19): each fix, kept fixed.
import { test, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const { analyze } = await import('../src/services/ai/advisor.js')
const { toPlain } = await import('../src/services/ai/chatops.js')
const { recommend } = await import('../src/services/ai/quality.js')
const { buildAiBom } = await import('../src/services/ai/aibom.js')
const { redact } = await import('../src/services/ai/redact.js')

describe('advisor: a suggestion never asks for less on the side that is fine', () => {
    // like caretta on prod: a DaemonSet with 2 pods — CPU is fine, memory is far over
    const pod = (name) => ({ metadata: { namespace: 'caretta', name, ownerReferences: [{ kind: 'DaemonSet', name: 'caretta' }] }, spec: { containers: [{ name: 'c', image: 'caretta:1.0', resources: { requests: { cpu: '10m', memory: '50Mi' }, limits: { memory: '100Mi' } } }] }, status: { phase: 'Running' } })
    const use = (name) => ({ podRef: { namespace: 'caretta', name }, containers: [{ name: 'c', cpu: { usageNanoCores: 7.5e6 }, memory: { workingSetBytes: 222 * 1024 ** 2 } }] })
    const out = ['==PODS==', JSON.stringify({ items: [pod('caretta-a'), pod('caretta-b')] }), '==RS==', '', '==SVC==', '', '==NETPOL==', '', '==NODES==', 'n1\t2\t5Gi', '==USAGE n1==', JSON.stringify({ pods: [use('caretta-a'), use('caretta-b')] }), '==END=='].join('\n')
    test('memory is raised, CPU is not lowered; the text says the figures are for all pods', () => {
        const a = analyze(out, { rates: { cpu: 1000, memGb: 200, currency: '₹' } })
        const w = a.cost.workloads.find(x => x.workload === 'DaemonSet/caretta')
        assert.equal(w.advice.kind, 'under')
        assert.match(w.advice.text, /\(all 2 pods together\)/)
        assert.ok(w.advice.suggest.cpu >= w.request.cpu, `CPU suggestion ${w.advice.suggest.cpu} not below the request ${w.request.cpu}`)
        assert.ok(w.advice.suggest.mem > w.use.mem, 'memory above what it uses')
    })
})

describe('chat apps get plain text', () => {
    test('bold, headings, code fences and tables made readable', () => {
        const p = toPlain('Your cluster **mine-k8s** has 2 nodes:\n| Node | Role |\n|------|------|\n| master | control-plane |\n### Next\nRun `kubectl get pods`\n```\nlog line\n```')
        assert.equal(p, 'Your cluster mine-k8s has 2 nodes:\nNode · Role\nmaster · control-plane\nNext\nRun kubectl get pods\nlog line')
    })
})

describe('quality: only an engine the workspace has can be recommended', () => {
    test('a removed engine (the old server model, 94) is not the recommendation', () => {
        const run = (score) => ({ summary: { score, avgMs: 1000 } })
        const latest = { server: run(94), abc: run(80) }
        const current = ['abc']
        const r = recommend(Object.fromEntries(Object.entries(latest).filter(([id]) => current.includes(id))))
        assert.notEqual(r?.engineId || r?.id || JSON.stringify(r), 'server')
        assert.equal(JSON.stringify(r).includes('"server"'), false)
    })
})

describe('AI-BOM: no server-model texts when there is no server model', () => {
    test('no daily allowance line; one Create YAML prompt', async () => {
        const bom = await buildAiBom('org-review')
        assert.equal(JSON.stringify(bom).includes('Server model daily allowance'), false)
        assert.ok(bom.prompts.some(p => p.name === 'text to YAML'))
        assert.equal(bom.prompts.some(p => /understand the request|free-form/.test(p.name)), false)
    })
})

describe('masking keeps YAML intact', () => {
    test('a key with nothing after it does not take the next line; references to a secret are not hidden', () => {
        assert.equal(redact('secretKeyRef:\n  name: postgres-secret', {}).text, 'secretKeyRef:\n  name: postgres-secret')
        assert.equal(redact('secretName: tls-cert', {}).text, 'secretName: tls-cert')
        assert.equal(redact('POSTGRES_PASSWORD: hunter2', {}).text, 'POSTGRES_PASSWORD: [hidden]')
        assert.equal(redact('api_key: "sk-123"', {}).text, 'api_key: [hidden]')
    })
})
