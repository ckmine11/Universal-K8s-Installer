import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { authService } from './authService.js'

// Feature flags: newer features can be switched on step by step.
//   platform   the server (superadmin, or KUBEEZ_FEATURES="gitops=on,helmApps=off"
//              and KUBEEZ_FEATURES_DEFAULT=on|off for the rest) — is it available?
//   workspace  an admin turns an available feature off (or back on) for their workspace
// A feature works only when both say on. A feature that is off answers 403
// FEATURE_OFF on its API, and its background work (GitOps alerts) stops.
export const FEATURES = {
    gitops:          { label: 'GitOps view & sync', group: 'GitOps', description: 'Argo CD / Flux apps per cluster, Sync now, AI explain' },
    gitopsAlerts:    { label: 'GitOps alerts', group: 'GitOps', description: 'Checks Argo CD / Flux every 3 minutes: sync failed / unhealthy incidents and alerts', background: true, plan: 'pro' },
    gitopsCreate:    { label: 'Create Argo CD apps', group: 'GitOps', description: 'New Argo CD apps from a Git repository, locked to one namespace', plan: 'pro' },
    gitopsPromote:   { label: 'Promote by pull request', group: 'GitOps', description: 'GitHub accounts and pull requests that change values in Git', plan: 'enterprise' },
    security:        { label: 'Security (Trivy)', group: 'Security', description: 'Image vulnerabilities and misconfigurations per workload' },
    externalSecrets: { label: 'External Secrets status', group: 'Security', description: 'Sync status of ExternalSecrets, Sync now', plan: 'pro' },
    dora:            { label: 'Delivery metrics (DORA)', group: 'Insight', description: 'Deploy frequency, change failure rate, recovery time' },
    appMetrics:      { label: 'App metrics', group: 'Insight', description: 'CPU, memory, restarts and network per workload from Prometheus' },
    helmApps:        { label: 'Helm apps', group: 'Apps', description: 'Install, upgrade, roll back and uninstall Helm releases; chart repositories; compare environments' },
    cveGate:         { label: 'CVE deploy gate', group: 'Apps', description: 'Per-environment policy that warns or blocks deploys of vulnerable images', plan: 'pro' },
    deployTokens:    { label: 'Deploy tokens & CI webhook', group: 'Apps', description: 'Tokens for CI pipelines and POST /api/hooks/deploy', plan: 'pro' },
    rollouts:        { label: 'Canary rollouts', group: 'Apps', description: 'Argo Rollouts: promote, abort, retry', plan: 'pro' },
    autoscale:       { label: 'Autoscaling (KEDA)', group: 'Apps', description: 'ScaledObjects from a wizard', plan: 'pro' },
    hibernate:       { label: 'Hibernate / Wake', group: 'Operations', description: 'Scale a namespace to 0 and back' },
    debug:           { label: 'Debug containers', group: 'Operations', description: 'Ephemeral debug containers in running pods', plan: 'pro' },
    registries:      { label: 'Registry pull secrets', group: 'Operations', description: 'Registry logins written as pull secrets into namespaces', plan: 'pro' }
}
export const FEATURE_KEYS = Object.keys(FEATURES)
// plans: free < pro < enterprise (the workspace owner's subscription, as for backups and alerts)
const PLAN_RANK = { free: 0, pro: 1, enterprise: 2, FREE: 0, PRO: 1, ENTERPRISE: 2 }
const planOf = (orgId) => { const p = orgId ? authService.getOrgPlan(orgId) : 'FREE'; return p in PLAN_RANK ? p : 'FREE' }
const FILE = path.join(DATA_DIR, 'features.json')

/** KUBEEZ_FEATURES="gitops=on,helmApps=off" → { gitops: true, helmApps: false } (unknown keys ignored) */
export function parseFeatureEnv(s) {
    const out = {}
    for (const part of String(s || '').split(',').map(x => x.trim()).filter(Boolean)) {
        const [k, v] = part.split('=').map(x => x.trim())
        if (FEATURES[k] && ['on', 'off', 'true', 'false', '1', '0'].includes(String(v).toLowerCase())) out[k] = ['on', 'true', '1'].includes(String(v).toLowerCase())
    }
    return out
}

class Features {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }

    /** Available on this server? superadmin's choice, else KUBEEZ_FEATURES, else KUBEEZ_FEATURES_DEFAULT (on). */
    platform(key) {
        const saved = this._read().platform?.[key]
        if (typeof saved === 'boolean') return saved
        const env = parseFeatureEnv(process.env.KUBEEZ_FEATURES)
        if (key in env) return env[key]
        return String(process.env.KUBEEZ_FEATURES_DEFAULT || 'on').toLowerCase() !== 'off'
    }
    /** On for this workspace? (available and not turned off by its admin) */
    isOn(orgId, key) {
        if (!FEATURES[key] || !this.platform(key)) return false
        const w = orgId ? this._read().orgs?.[orgId]?.[key] : undefined
        return w !== false
    }
    /** Does the workspace's plan include it? (the platform owner always) */
    planOk(orgId, key, role = null) {
        if (role === 'superadmin') return true
        return PLAN_RANK[planOf(orgId)] >= PLAN_RANK[FEATURES[key]?.plan || 'free']
    }
    /** On and paid for — what background work and gates use. */
    usable(orgId, key) { return this.isOn(orgId, key) && this.planOk(orgId, key) }
    /** Everything for the settings page and the UI. */
    view(orgId, role = null) {
        const orgs = orgId ? this._read().orgs?.[orgId] || {} : {}
        return FEATURE_KEYS.map(key => ({ key, ...FEATURES[key], plan: FEATURES[key].plan || 'free', available: this.platform(key), workspace: orgs[key] !== false, on: this.isOn(orgId, key), included: this.planOk(orgId, key, role) }))
    }
    enabled(orgId) { return Object.fromEntries(FEATURE_KEYS.map(k => [k, this.isOn(orgId, k)])) }

    setWorkspace(orgId, changes) {
        if (!orgId) throw Object.assign(new Error('Features belong to a workspace'), { status: 400 })
        const all = this._read(); const o = (all.orgs ||= {})[orgId] ||= {}
        for (const [k, v] of Object.entries(changes || {})) if (FEATURES[k] && typeof v === 'boolean') { if (v) delete o[k]; else o[k] = false }
        this._write(all)
        return this.view(orgId)
    }
    /** superadmin: on / off for the whole server, or null to follow the environment variables again. */
    setPlatform(changes) {
        const all = this._read(); const p = all.platform ||= {}
        for (const [k, v] of Object.entries(changes || {})) if (FEATURES[k]) { if (v === null) delete p[k]; else if (typeof v === 'boolean') p[k] = v }
        this._write(all)
        return FEATURE_KEYS.map(key => ({ key, ...FEATURES[key], available: this.platform(key), saved: typeof p[key] === 'boolean' ? p[key] : null }))
    }
}
export const features = new Features()

/**
 * Middleware: the feature must be on for the member's workspace (403 FEATURE_OFF)
 * and in its plan (402 UPGRADE_REQUIRED — the page offers the upgrade).
 */
export const requireFeature = (key) => (req, res, next) => {
    const orgId = req.user?.orgId || null
    if (!features.isOn(orgId, key)) return res.status(403).json({ error: `${FEATURES[key]?.label || key} is turned off${features.platform(key) ? ' for this workspace (Settings → Features)' : ' on this server'}.`, code: 'FEATURE_OFF', feature: key })
    if (!features.planOk(orgId, key, req.user?.role)) return res.status(402).json(upgradeBody(key))
    next()
}
export const upgradeBody = (key) => {
    const plan = FEATURES[key]?.plan === 'enterprise' ? 'Enterprise' : 'Pro'
    return { error: `${FEATURES[key]?.label || key} is part of the ${plan} plan — upgrade your plan (Plans page) to use it.`, code: 'UPGRADE_REQUIRED', upgradeRequired: true, plan: plan.toUpperCase(), feature: key }
}
