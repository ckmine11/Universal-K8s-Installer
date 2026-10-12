// Every KubeEZ add-on is a Helm add-on with settings: a form with safe
// defaults, change later with a preview and automatic rollback, history,
// versions, and advanced Helm values (Pro). Definitions: config/addons/*.js
// (the format is described in config/addons/common.js).
import { CORE_ADDONS } from './addons/core.js'
import { EXTRA_ADDONS } from './addons/extras.js'
import { minorOf, tagVersion } from './addons/common.js'

export { SYSTEM_NAMESPACES } from './addons/common.js'
export { parseAddressPool, KYVERNO_POLICIES, GRAFANA_DATASOURCES_WITH_LOKI, LOKI_DATASOURCE_CM } from './addons/extras.js'

// Order = the order on the cluster page
export const HELM_ADDONS = { ...CORE_ADDONS, ...EXTRA_ADDONS }

export const HELM_ADDON_KEYS = Object.keys(HELM_ADDONS)
export const isHelmAddon = (key) => Object.prototype.hasOwnProperty.call(HELM_ADDONS, key)
// older keys the UI / saved clusters may still use
export const ADDON_KEY_ALIASES = { certManager: 'cert-manager' }
export const normAddonKey = (k) => ADDON_KEY_ALIASES[k] || k

/** Defaults of the form fields */
export function defaultSettings(key) {
    return Object.fromEntries(HELM_ADDONS[key].fields.map(f => [f.key, f.default]))
}

/** Can this version run on Kubernetes 1.<minor>? (unknown minor = yes) */
export const versionFits = (v, k8sMinor) => !k8sMinor || !v.kube || (k8sMinor >= v.kube[0] && k8sMinor <= v.kube[1])

/** The versions offered for a cluster, newest first; the first that fits is recommended */
export function versionsFor(key, k8sMinor) {
    const list = HELM_ADDONS[key].versions.map(v => ({ id: v.id, app: v.app, fits: versionFits(v, k8sMinor), kube: v.kube || null }))
    const rec = list.find(v => v.fits) || list[0]
    return list.map(v => ({ ...v, recommended: v === rec }))
}

/** The version that matches what runs now (same release line), for a takeover / repair */
export function versionForRunning(key, runningApp) {
    // an image ("longhornio/longhorn-manager:v1.7.2@sha256:…") or a version
    const mm = minorOf(tagVersion(runningApp))
    return mm ? HELM_ADDONS[key].versions.find(v => minorOf(v.app) === mm) || null : null
}

/** What the UI needs to draw the form */
export function addonSchema(key, { k8sMinor } = {}) {
    const a = HELM_ADDONS[key]
    // release names (for the advanced YAML hint) from a plan with a sample context
    const sample = { clusterId: 'c', k8sMinor: k8sMinor || 35, nodeCount: 3, workerCount: 2, addons: { longhorn: true, monitoring: true }, velero: { bucket: 'b' } }
    let releases = []
    try {
        const s = a.validate({ ...defaultSettings(key), ...(key === 'metallb' ? { addresses: '192.0.2.10-192.0.2.20' } : {}) }, sample)
        releases = a.releases(s, sample, a.versions[0]).map(r => r.name)
    } catch { releases = [key] }
    return {
        key, label: a.label, summary: a.summary, namespace: a.ns, tier: a.tier, keepsData: !!a.keepsData, needsSettings: !!a.needsSettings,
        fields: a.fields, defaults: defaultSettings(key),
        versions: versionsFor(key, k8sMinor), stepUpgrade: !!a.stepUpgrade,
        takeoverNote: a.takeover?.note || null,
        releases, uninstallNote: a.uninstallNote
    }
}
