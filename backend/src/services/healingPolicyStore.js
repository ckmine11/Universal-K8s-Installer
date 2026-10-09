import fs from 'fs'
import path from 'path'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { REASONS, POLICIES, defaultPolicies } from '../config/incidentCatalog.js'

// Auto-healing settings per workspace (orgId):
//   policies    — per problem type: auto (fix) / notify (alert only) / off
//   maintenance — clusterId → until (no detection, no fixes, no alerts)
//   mutes       — incident key → until (no alerts, no fixes for that one)
const FILE = path.join(DATA_DIR, 'healing.json')
const MAX_HOURS = 24 * 14

class HealingPolicyStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }
    _org(all, orgId) {
        const o = all[orgId] ||= {}
        o.policies = { ...defaultPolicies(), ...(o.policies || {}) }
        o.maintenance ||= {}
        o.mutes ||= {}
        // drop what has run out
        const now = Date.now()
        for (const m of [o.maintenance, o.mutes]) for (const [k, v] of Object.entries(m)) if (new Date(v.until).getTime() <= now) delete m[k]
        return o
    }

    view(orgId) { return this._org(this._read(), orgId || '_') }
    policy(orgId, reason) { return this.view(orgId).policies[reason] || 'notify' }

    savePolicies(orgId, policies = {}) {
        const all = this._read(); const o = this._org(all, orgId)
        for (const [k, v] of Object.entries(policies)) if (REASONS.includes(k) && POLICIES.includes(v)) o.policies[k] = v
        this._write(all); return o.policies
    }

    inMaintenance(orgId, clusterId) { return !!this.view(orgId).maintenance[clusterId] }
    setMaintenance(orgId, clusterId, hours, by) {
        const all = this._read(); const o = this._org(all, orgId)
        if (!hours) delete o.maintenance[clusterId]
        else o.maintenance[clusterId] = { until: new Date(Date.now() + Math.min(MAX_HOURS, Number(hours)) * 3600e3).toISOString(), by }
        this._write(all); return o.maintenance[clusterId] || null
    }

    muted(orgId, key) { return this.view(orgId).mutes[key] || null }
    mute(orgId, key, hours, by) {
        const all = this._read(); const o = this._org(all, orgId)
        if (!hours) delete o.mutes[key]
        else o.mutes[key] = { until: new Date(Date.now() + Math.min(MAX_HOURS, Number(hours)) * 3600e3).toISOString(), by }
        this._write(all); return o.mutes[key] || null
    }
}

export const healingPolicyStore = new HealingPolicyStore()
