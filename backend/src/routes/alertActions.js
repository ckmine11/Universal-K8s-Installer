import express from 'express'
import rateLimit from 'express-rate-limit'
import { verifyAction, performAction, actionLabel } from '../services/alertActions.js'
import { incidentDetector } from '../services/incidentDetector.js'
import { label } from '../config/incidentCatalog.js'

// Signed links in alerts (Slack, Teams, email, WhatsApp, webhook). No login:
// the signature is the permission, for 24 hours, for one incident and one
// action. GET only shows a confirmation page — chat apps and mail scanners
// open links on their own; only the button (POST) acts.
const router = express.Router()
router.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }))

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function page(res, status, { title, body, form }) {
    res.status(status)
        .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
        .set('Cache-Control', 'no-store')
        .set('Referrer-Policy', 'no-referrer')
        .type('html')
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · KubeEZ</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b1a;color:#e2e8f0;font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
.c{max-width:440px;width:100%;background:#0f1630;border:1px solid #1e2a4a;border-radius:16px;padding:28px}
h1{font-size:19px;margin:0 0 6px}p{margin:6px 0;color:#94a3b8}b{color:#e2e8f0}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:10px;background:#22d3ee;color:#04111d;font-weight:700;font-size:15px;cursor:pointer}
.k{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#22d3ee;margin-bottom:10px}</style></head>
<body><div class="c"><div class="k">KubeEZ</div><h1>${esc(title)}</h1>${body}${form || ''}</div></body></html>`)
}

const describe = (inc) => `<p><b>${esc(label(inc.reason))}</b> — ${esc(inc.target)}</p><p>Cluster: ${esc(inc.clusterName || inc.clusterId)}</p>`

router.get('/:token', (req, res) => {
    try {
        const p = verifyAction(req.params.token)
        const inc = incidentDetector.find(p.i)
        if (!inc) return page(res, 404, { title: 'Incident not found', body: '<p>It no longer exists (incidents are kept 7 days).</p>' })
        if (['resolved', 'cleared'].includes(inc.status)) return page(res, 200, { title: 'Already closed', body: `${describe(inc)}<p>Nothing to do.</p>` })
        page(res, 200, {
            title: `${actionLabel(p.action)}?`, body: describe(inc),
            form: `<form method="post" action="${esc(req.params.token)}"><button type="submit">${esc(actionLabel(p.action))}</button></form>`
        })
    } catch (e) { page(res, e.status || 400, { title: e.message, body: '' }) }
})

router.post('/:token', async (req, res) => {
    try {
        const p = verifyAction(req.params.token)
        const r = await performAction({ incidentId: p.i, orgId: p.o, action: p.action, by: 'alert link' })
        page(res, 200, { title: 'Done', body: `${describe(r.incident)}<p>${esc(r.text)}</p>` })
    } catch (e) { page(res, e.status || 400, { title: e.message, body: '' }) }
})

export default router
