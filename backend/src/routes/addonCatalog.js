import express from 'express'
import { requirePermission } from '../middleware/authMiddleware.js'
import { HELM_ADDONS, isHelmAddon, addonSchema } from '../config/helmAddons.js'
import { buildPlan, valuesYaml } from '../services/addonSettings.js'
import { authService } from '../services/authService.js'
import { isPaidPlan } from '../config/planFeatures.js'

// The add-on catalogue for customizing add-ons BEFORE a cluster exists (the
// new-cluster wizard): the forms, and a preview of the values for the cluster
// being created. Installed add-ons use /api/clusters/:id/addons/:key/settings.
const router = express.Router()
router.use(requirePermission('addon:install'))

const advancedAllowed = (req) => isPaidPlan(authService.getOrgPlan(req.user.orgId)) || req.user.role === 'superadmin'
const minorOf = (v) => Number(String(v || '').split('.')[1]) || null

router.get('/', (req, res) => {
    const k8sMinor = minorOf(req.query.k8sVersion)
    res.json({ addons: Object.keys(HELM_ADDONS).map(k => addonSchema(k, { k8sMinor })), advancedAllowed: advancedAllowed(req) })
})

// body: { settings, advanced, version, cluster: { k8sVersion, masterNodes:[{ip}], workerNodes, controlPlaneVip, addons } }
router.post('/:key/preview', (req, res) => {
    try {
        const key = req.params.key
        if (!isHelmAddon(key)) return res.status(404).json({ error: 'Unknown add-on' })
        const { settings, advanced, version, cluster = {} } = req.body || {}
        if (advanced && String(advanced).trim() && !advancedAllowed(req)) {
            return res.status(402).json({ error: 'Advanced values (Helm YAML) are part of Pro. On Free, use the settings form.', upgrade: true })
        }
        const draft = {
            id: 'new-cluster', k8sVersion: cluster.k8sVersion, controlPlaneVip: cluster.controlPlaneVip,
            masterNodes: (cluster.masterNodes || []).map(n => ({ ip: n?.ip })), workerNodes: (cluster.workerNodes || []).map(n => ({ ip: n?.ip })),
            addons: cluster.addons || {}
        }
        const plan = buildPlan(key, draft, { settings, advanced, version })
        res.json({ settings: plan.settings, version: plan.version, ignored: plan.ignored, values: valuesYaml(plan) })
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

export default router
