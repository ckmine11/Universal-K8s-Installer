import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { encrypt, decrypt } from '../utils/cryptoUtils.js'

// Delivery settings per workspace (orgId):
//   environments  name → a namespace on a cluster (dev / staging / prod…);
//                 a protected one needs a second person for every deploy
//   repos         Helm chart repositories the team may deploy from (https or
//                 oci://); a password is kept encrypted and never sent back
//   freezes       change freezes: no deploys, rollbacks or GitOps syncs on
//                 the clusters they cover until they end (admins may override)
const FILE = path.join(DATA_DIR, 'delivery.json')
const bad = (m) => Object.assign(new Error(m), { status: 400 })
const id = () => randomBytes(6).toString('hex')

export const ENV_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/
export const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
const REPO_NAME = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/
const MAX = { environments: 100, repos: 50, freezes: 100 }

/** A chart repository address: https://… (index.yaml) or oci://… — never with user:password in it. */
export function cleanRepoUrl(url) {
    const s = String(url || '').trim().replace(/\/+$/, '')
    let u
    try { u = new URL(s) } catch { throw bad('The repository address is not a valid URL') }
    if (!['https:', 'oci:'].includes(u.protocol)) throw bad('Use an https:// or oci:// repository address')
    if (u.username || u.password) throw bad('Put the user name and password in their own fields, not in the address')
    if (u.search || u.hash) throw bad('The repository address may not have ?query or #fragment')
    if (s.length > 300) throw bad('The repository address is too long')
    return s
}

class DeliveryStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }
    _org(all, orgId) {
        const o = all[orgId || '_'] ||= {}
        o.environments ||= []; o.repos ||= []; o.freezes ||= []
        return o
    }
    _edit(orgId, fn) { const all = this._read(); const o = this._org(all, orgId); const r = fn(o); this._write(all); return r }

    // ── environments ──
    environments(orgId) { return this._org(this._read(), orgId).environments.slice().sort((a, b) => a.name.localeCompare(b.name)) }
    environment(orgId, envId) { return this.environments(orgId).find(e => e.id === envId) || null }
    /** The environment a namespace on a cluster belongs to (if any). */
    environmentAt(orgId, clusterId, namespace) { return this.environments(orgId).find(e => e.clusterId === clusterId && e.namespace === namespace) || null }
    saveEnvironment(orgId, input, { clusterIds, by } = {}) {
        const name = String(input?.name || '').trim().toLowerCase()
        if (!ENV_NAME.test(name)) throw bad('Name: lowercase letters, digits and dashes (e.g. prod, staging)')
        if (!clusterIds?.includes(input?.clusterId)) throw bad('Pick a cluster of this workspace')
        if (!NAMESPACE.test(String(input?.namespace || ''))) throw bad('Namespace is not a valid Kubernetes namespace')
        return this._edit(orgId, (o) => {
            const cur = input.id ? o.environments.find(e => e.id === input.id) : null
            if (input.id && !cur) throw Object.assign(new Error('Environment not found'), { status: 404 })
            if (o.environments.some(e => e.name === name && e.id !== input.id)) throw bad(`There is already an environment called ${name}`)
            if (o.environments.some(e => e.clusterId === input.clusterId && e.namespace === input.namespace && e.id !== input.id)) throw bad('That namespace on that cluster is already an environment')
            if (!cur && o.environments.length >= MAX.environments) throw bad(`A workspace can have up to ${MAX.environments} environments`)
            const env = { id: cur?.id || id(), name, clusterId: input.clusterId, namespace: input.namespace, protected: !!input.protected, updatedAt: new Date().toISOString(), updatedBy: by || null }
            if (cur) Object.assign(cur, env); else o.environments.push(env)
            return env
        })
    }
    removeEnvironment(orgId, envId) { return this._edit(orgId, (o) => { const n = o.environments.length; o.environments = o.environments.filter(e => e.id !== envId); return n !== o.environments.length }) }

    // ── chart repositories ──
    repos(orgId) { return this._org(this._read(), orgId).repos.map(r => ({ id: r.id, name: r.name, url: r.url, username: r.username || null, hasPassword: !!r.password })).sort((a, b) => a.name.localeCompare(b.name)) }
    repo(orgId, repoId) { return this.repos(orgId).find(r => r.id === repoId) || null }
    /** With the password (decrypted) — only for the helm command, never for the browser. */
    repoCredentials(orgId, repoId) {
        const r = this._org(this._read(), orgId).repos.find(x => x.id === repoId)
        if (!r) return null
        let password = null
        try { password = r.password ? decrypt(r.password) : null } catch { password = null }
        return { ...r, password }
    }
    saveRepo(orgId, input, { by } = {}) {
        const name = String(input?.name || '').trim().toLowerCase()
        if (!REPO_NAME.test(name)) throw bad('Name: lowercase letters, digits and dashes')
        const url = cleanRepoUrl(input?.url)
        const username = input?.username ? String(input.username).trim().slice(0, 120) : null
        if (username && !/^[\w.@+-]+$/.test(username)) throw bad('The user name has characters that are not allowed')
        return this._edit(orgId, (o) => {
            const cur = input.id ? o.repos.find(r => r.id === input.id) : null
            if (input.id && !cur) throw Object.assign(new Error('Repository not found'), { status: 404 })
            if (o.repos.some(r => r.name === name && r.id !== input.id)) throw bad(`There is already a repository called ${name}`)
            if (!cur && o.repos.length >= MAX.repos) throw bad(`A workspace can have up to ${MAX.repos} repositories`)
            // a password left empty on edit keeps the old one; clearPassword removes it
            const password = input.password ? encrypt(String(input.password).slice(0, 500)) : input.clearPassword ? null : cur?.password || null
            const repo = { id: cur?.id || id(), name, url, username, password, updatedAt: new Date().toISOString(), updatedBy: by || null }
            if (cur) Object.assign(cur, repo); else o.repos.push(repo)
            return this.repos(orgId).find(r => r.id === repo.id) || { id: repo.id, name, url, username, hasPassword: !!password }
        })
    }
    removeRepo(orgId, repoId) { return this._edit(orgId, (o) => { const n = o.repos.length; o.repos = o.repos.filter(r => r.id !== repoId); return n !== o.repos.length }) }

    // ── change freezes ──
    freezes(orgId) { const now = Date.now(); return this._org(this._read(), orgId).freezes.filter(f => Date.parse(f.until) > now).sort((a, b) => a.from.localeCompare(b.from)) }
    /** The freeze that covers this cluster right now, or null. */
    activeFreeze(orgId, clusterId, now = Date.now()) {
        return this.freezes(orgId).find(f => Date.parse(f.from) <= now && Date.parse(f.until) > now && (!f.clusterIds?.length || f.clusterIds.includes(clusterId))) || null
    }
    saveFreeze(orgId, input, { clusterIds = [], by } = {}) {
        const from = Date.parse(input?.from), until = Date.parse(input?.until)
        if (Number.isNaN(from) || Number.isNaN(until)) throw bad('Give a start and an end time')
        if (until <= from) throw bad('The end must be after the start')
        if (until <= Date.now()) throw bad('That freeze has already ended')
        if (until - from > 31 * 86400e3) throw bad('A freeze can last up to 31 days')
        const reason = String(input?.reason || '').trim().slice(0, 200)
        if (reason.length < 3) throw bad('Say why (e.g. "Diwali sale", "year-end release")')
        const scope = Array.isArray(input?.clusterIds) ? [...new Set(input.clusterIds)] : []
        if (scope.some(c => !clusterIds.includes(c))) throw bad('Pick clusters of this workspace')
        return this._edit(orgId, (o) => {
            o.freezes = o.freezes.filter(f => Date.parse(f.until) > Date.now())
            if (o.freezes.length >= MAX.freezes) throw bad(`Up to ${MAX.freezes} freezes`)
            const f = { id: id(), from: new Date(from).toISOString(), until: new Date(until).toISOString(), reason, clusterIds: scope, createdAt: new Date().toISOString(), createdBy: by || null }
            o.freezes.push(f)
            return f
        })
    }
    removeFreeze(orgId, freezeId) { return this._edit(orgId, (o) => { const n = o.freezes.length; o.freezes = o.freezes.filter(f => f.id !== freezeId); return n !== o.freezes.length }) }

    /** Remove everything about a cluster that is gone. */
    dropCluster(orgId, clusterId) {
        this._edit(orgId, (o) => {
            o.environments = o.environments.filter(e => e.clusterId !== clusterId)
            for (const f of o.freezes) f.clusterIds = (f.clusterIds || []).filter(c => c !== clusterId)
        })
    }
}

export const deliveryStore = new DeliveryStore()

/**
 * Refuse a change while a freeze covers the cluster — unless an admin
 * overrides it with a reason (it is recorded). → null or the override text.
 */
export function checkFreeze(user, cluster, body = {}) {
    const f = deliveryStore.activeFreeze(cluster.orgId, cluster.id)
    if (!f) return null
    const admin = ['admin', 'superadmin'].includes(user?.role)
    const why = String(body?.overrideFreeze || '').trim()
    if (admin && why.length >= 3) return `freeze "${f.reason}" overridden: ${why.slice(0, 200)}`
    throw Object.assign(new Error(`Change freeze until ${new Date(f.until).toUTCString()}: ${f.reason}.${admin ? ' As an admin you may override it with a reason.' : ' Ask an admin.'}`), { status: 423, code: 'FROZEN', freeze: f })
}
