import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { aiStore } from '../services/ai/aiStore.js'
import { serverAvailable } from '../services/ai/engine.js'
import { serverModel } from '../services/ai/providers.js'
import { auditLog } from '../services/auditLog.js'
import { EXAM, EXAM_VERSION, startExam, cancelExam, isRunning, runsOf, runView, latestByEngine, recommend, giveFeedback, feedbackStats, REASONS } from '../services/ai/quality.js'

// KubeEZ AI quality (mounted at /api/ai): the exam, the comparison, feedback.
const router = express.Router()
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message })

// every engine of the workspace, incl. the server model — by id
function enginesOf(orgId) {
    const list = aiStore.get(orgId).providers.map(p => ({ ...p }))
    if (serverAvailable()) list.push({ id: 'server', name: 'KubeEZ server model', kind: 'server', builtin: true, model: serverModel().model })
    return list
}

router.get('/quality', requirePermission('ai:manage'), (req, res) => {
    const latest = latestByEngine(req.user.orgId)
    res.json({
        examVersion: EXAM_VERSION, running: isRunning(req.user.orgId),
        cases: EXAM.map(c => ({ id: c.id, title: c.title, kind: c.kind, trap: c.trap || null })),
        runs: runsOf(req.user.orgId).slice(0, 30).map(runView),
        latest, recommended: recommend(latest), feedback: feedbackStats(req.user.orgId), reasons: REASONS,
        engines: enginesOf(req.user.orgId).map(e => ({ id: e.id, name: e.name, kind: e.kind, model: e.model || null }))
    })
})

router.get('/quality/runs/:id', requirePermission('ai:manage'), (req, res) => {
    const r = runsOf(req.user.orgId).find(x => x.id === req.params.id)
    if (!r) return res.status(404).json({ error: 'Run not found' })
    const titles = Object.fromEntries(EXAM.map(c => [c.id, { title: c.title, trap: c.trap || null, kind: c.kind }]))
    res.json({ ...r, results: r.results.map(x => ({ ...x, ...titles[x.id] })) })
})

// run the exam on one or more engines (one after the other, in the background)
router.post('/quality/run', requirePermission('ai:manage'), (req, res) => {
    try {
        const ids = Array.isArray(req.body?.engineIds) ? [...new Set(req.body.engineIds)].slice(0, 10) : []
        const all = enginesOf(req.user.orgId)
        const engines = ids.map(id => all.find(e => e.id === id))
        if (!ids.length || engines.some(e => !e)) throw Object.assign(new Error('Pick engines from your list'), { status: 400 })
        const caseIds = Array.isArray(req.body?.caseIds) ? req.body.caseIds.filter(id => EXAM.some(c => c.id === id)) : null
        const runs = startExam(req.user, engines, { caseIds: caseIds?.length ? caseIds : null })
        auditLog.record({ orgId: req.user.orgId, actor: req.user, ip: req.ip, action: 'ai.quality_test', detail: `Quality test started: ${engines.map(e => e.name).join(', ')} (${runs[0].cases} cases)` })
        res.status(202).json({ runs: runs.map(runView) })
    } catch (e) { fail(res, e) }
})
router.post('/quality/cancel', requirePermission('ai:manage'), (req, res) => {
    res.json({ cancelled: cancelExam(req.user.orgId) })
})

// 👍 / 👎 on any answer (by its trace id)
router.post('/feedback', requirePermission('ai:use'), (req, res) => {
    try {
        const traceId = String(req.body?.traceId || '')
        if (!/^[0-9a-f]{12}$/.test(traceId)) throw Object.assign(new Error('Which answer?'), { status: 400 })
        res.json(giveFeedback(req.user, traceId, req.body || {}))
    } catch (e) { fail(res, e) }
})

export default router
