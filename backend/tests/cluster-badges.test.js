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
    assert.deepEqual(securityBadge(security, null), { count: 2, total: 2, tone: 'red', title: '2 critical vulnerabilities' })
    assert.equal(securityBadge(security, (ns) => ns === 'shop').count, 1)
    assert.equal(securityBadge(security, (ns) => ns === 'none').count, 0)
    assert.equal(securityBadge(null, null), null)
})

test('certificates badge: red for expired or failing, amber for expiring only', () => {
    const b = certificatesBadge(certs([['a', 'ok'], ['a', 'expiring'], ['b', 'failing'], ['b', 'expired']]), null)
    assert.deepEqual(b, { count: 3, total: 3, tone: 'red', title: '3 certificates need attention' })
    assert.deepEqual(certificatesBadge(certs([['a', 'expiring'], ['b', 'expired']]), (ns) => ns === 'a'), { count: 1, total: 1, tone: 'amber', title: '1 certificate needs attention' })
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

test('seen: what the person looked at stops counting; something new — or getting worse — counts again', () => {
    // all three CVEs seen → no badge, the title still says they are there
    const seenAll = securityBadge(security, null, new Set(['CVE-1', 'CVE-3']))
    assert.deepEqual(seenAll, { count: 0, total: 2, tone: 'red', title: '2 critical vulnerabilities — seen' })
    // one new CVE since → 1, with the total
    assert.deepEqual(securityBadge(security, null, new Set(['CVE-1'])), { count: 1, total: 2, tone: 'red', title: '1 new critical vulnerability (2 in all)' })
    // a certificate seen while expiring that has now expired counts again, in red
    const c = certs([['a', 'expired']])
    assert.equal(certificatesBadge(c, null, new Set(['a/c0:expiring'])).count, 1)
    assert.equal(certificatesBadge(c, null, new Set(['a/c0:expired'])).count, 0)
})

test('badgeSeen: per person and cluster; marking replaces (a problem that went away counts again if it returns)', async () => {
    // a throw-away data folder: never backend/data
    const { tempDataDir } = await import('./helpers/server.js')
    const dir = tempDataDir()
    process.env.KUBEEZ_DATA_DIR = dir
    const { DATA_DIR } = await import('../src/utils/paths.js')
    assert.equal(DATA_DIR, dir)
    const { badgeSeen } = await import('../src/services/badgeSeen.js')
    badgeSeen._reset()
    badgeSeen.mark('u1', 'c1', 'security', ['CVE-1', 'CVE-2'])
    assert.deepEqual([...badgeSeen.get('u1', 'c1', 'security')], ['CVE-1', 'CVE-2'])
    assert.equal(badgeSeen.get('u2', 'c1', 'security').size, 0, 'a teammate has not seen it')
    assert.equal(badgeSeen.get('u1', 'c2', 'security').size, 0, 'another cluster')
    badgeSeen.mark('u1', 'c1', 'security', ['CVE-2'])
    assert.deepEqual([...badgeSeen.get('u1', 'c1', 'security')], ['CVE-2'])
})
