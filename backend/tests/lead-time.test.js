// DORA lead time for changes: the commit CI sends with the deploy webhook is
// checked, and computeDora turns the recorded changes into a median + level.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
const { cleanCommit, leadTimes } = await import('../src/services/leadTime.js')
const dora = await import('../src/services/dora.js')
after(() => fs.rmSync(DATA, { recursive: true, force: true }))

const NOW = Date.parse('2026-10-31T12:00:00Z')
const iso = (t) => new Date(t).toISOString()

test('cleanCommit: none is fine; a hash and a sane date are required when sent', () => {
    assert.equal(cleanCommit(undefined), null)
    assert.deepEqual(cleanCommit({ sha: 'ABCDEF1', time: '2026-10-31T10:00:00+05:30' }, NOW), { sha: 'abcdef1', commitAt: '2026-10-31T04:30:00.000Z' })
    for (const c of ['x', { sha: 'zzz', time: iso(NOW) }, { sha: 'abcdef1', time: 'yesterday' }, { sha: 'abcdef1', time: iso(NOW + 3600e3) }, { sha: 'abcdef1', time: '2020-01-01T00:00:00Z' }])
        assert.throws(() => cleanCommit(c, NOW), (e) => e.status === 400)
})

test('the store keeps changes per workspace and cluster', () => {
    leadTimes.record('o1', { clusterId: 'c1', namespace: 'shop', release: 'web', sha: 'abc1234', commitAt: iso(NOW - 3600e3) })
    leadTimes.record('o2', { clusterId: 'c1', namespace: 'shop', release: 'web', sha: 'abc1235', commitAt: iso(NOW - 3600e3) })
    assert.equal(leadTimes.forCluster('o1', 'c1').length, 1)
    assert.equal(leadTimes.forCluster('o1', 'c2').length, 0)
})

test('computeDora: median lead time, level, scope and window', () => {
    const ch = (ns, commitH, deployH) => ({ namespace: ns, release: 'web', sha: 'abcdef1234567890', commitAt: iso(NOW - commitH * 3600e3), deployedAt: iso(NOW - deployH * 3600e3) })
    const changes = [ch('shop', 5, 4), ch('shop', 30, 2), ch('shop', 10, 7), ch('team-b', 500, 1), ch('kube-system', 2, 1), ch('shop', 400, 300)]
    const r = dora.computeDora({ rollouts: [], changes, from: NOW - 7 * 86400e3, to: NOW })
    // shop: 60, 1680, 180 min; team-b: 29940; kube-system is platform; the last one is outside the window
    assert.equal(r.leadTime.available, true); assert.equal(r.leadTime.changes, 4)
    assert.equal(r.leadTime.medianMinutes, Math.round((180 + 1680) / 2)); assert.equal(r.leadTime.level, 'elite')
    assert.equal(r.leadTime.recent[0].namespace, 'team-b')
    assert.equal(r.leadTime.recent.length, 4); assert.equal(r.leadTime.recent[0].sha.length, 12)
    const scoped = dora.computeDora({ rollouts: [], changes, from: NOW - 7 * 86400e3, to: NOW, match: (ns) => ns === 'shop' })
    assert.equal(scoped.leadTime.changes, 3); assert.equal(scoped.leadTime.medianMinutes, 180)
    assert.equal(dora.computeDora({ rollouts: [], from: NOW - 86400e3, to: NOW }).leadTime.available, false)
    assert.equal(dora.levelOf('lead', 30), 'elite'); assert.equal(dora.levelOf('lead', 3000), 'high'); assert.equal(dora.levelOf('lead', 20000), 'medium'); assert.equal(dora.levelOf('lead', 50000), 'low')
})
