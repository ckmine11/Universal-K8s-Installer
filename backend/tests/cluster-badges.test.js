import { test } from 'node:test'
import assert from 'node:assert/strict'
import { securityBadge, certificatesBadge, clusterBadges } from '../src/services/clusterBadges.js'
import { _test as securityTest } from '../src/services/security.js'
import { _test as certTest } from '../src/services/certManager.js'

const counts = (critical = 0, high = 0) => ({ critical, high, medium: 0, low: 0 })
const report = (namespace, name, vulns) => ({
    namespace, kind: 'Deployment', name, container: 'app', image: `${name}:1`, updatedAt: '2026-11-01T00:00:00Z',
    counts: counts(vulns.filter(v => v.severity === 'CRITICAL').length, vulns.filter(v => v.severity === 'HIGH').length),
    vulns: vulns.map(v => ({ pkg: 'openssl', installed: '1', fixed: '', score: 9, title: v.id, ...v })),
})
const security = {
    tools: {}, audits: [],
    reports: [
        report('shop', 'web', [{ severity: 'CRITICAL', id: 'CVE-1' }, { severity: 'HIGH', id: 'CVE-2' }]),
        report('shop', 'api', [{ severity: 'CRITICAL', id: 'CVE-1' }]),          // same CVE: counted once
        report('billing', 'pay', [{ severity: 'CRITICAL', id: 'CVE-3' }]),
    ],
}
const certs = (states) => ({ tool: { state: 'ok' }, issuers: [], challenges: [], certificates: states.map(([namespace, state], i) => ({ namespace, name: `c${i}`, state })) })

test('security badge: distinct critical CVEs, within the namespaces the member may see', () => {
    assert.deepEqual(securityBadge(security, null), { count: 2, tone: 'red', title: '2 critical vulnerabilities' })
    assert.equal(securityBadge(security, (ns) => ns === 'shop').count, 1)
    assert.equal(securityBadge(security, (ns) => ns === 'none').count, 0)
    assert.equal(securityBadge(null, null), null)
})

test('certificates badge: red for expired or failing, amber for expiring only', () => {
    const b = certificatesBadge(certs([['a', 'ok'], ['a', 'expiring'], ['b', 'failing'], ['b', 'expired']]), null)
    assert.deepEqual(b, { count: 3, tone: 'red', title: '2 expired or failing, 1 expiring soon' })
    assert.deepEqual(certificatesBadge(certs([['a', 'expiring'], ['b', 'expired']]), (ns) => ns === 'a'), { count: 1, tone: 'amber', title: '1 expiring soon' })
    assert.equal(certificatesBadge(certs([['a', 'ok']]), null).count, 0)
    assert.equal(certificatesBadge({ ...certs([]), tool: { state: 'missing' } }, null), null)
    assert.equal(certificatesBadge(null, null), null)
})

test('clusterBadges: only allowed sections; never read → null and one background read', async () => {
    let calls = 0
    const fake = async () => { calls++; return { execCommand: async () => ({ stdout: '', stderr: 'unreachable' }), dispose() { } } }
    securityTest.useConnect(fake)
    certTest.useConnect(fake)
    try {
        const cluster = { id: 'badge-1', orgId: 'o1', status: 'healthy' }
        const all = clusterBadges(cluster, { allowed: () => true })
        assert.deepEqual(all, { security: null, certificates: null })
        clusterBadges(cluster, { allowed: () => true })   // a read is already running: not started again
        await new Promise(r => setTimeout(r, 20))
        assert.equal(calls, 2)
        assert.deepEqual(clusterBadges(cluster, { allowed: (k) => k === 'certificates', refresh: false }), { certificates: null })
        const failed = clusterBadges({ ...cluster, id: 'badge-2', status: 'failed', mode: 'install' }, { allowed: () => true })
        await new Promise(r => setTimeout(r, 20))
        assert.deepEqual(failed, { security: null, certificates: null })
        assert.equal(calls, 2, 'a cluster whose install failed is not read')
    } finally {
        securityTest.useConnect(null)
        certTest.useConnect(null)
    }
})
