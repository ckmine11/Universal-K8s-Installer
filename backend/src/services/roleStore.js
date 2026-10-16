import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { DATA_DIR } from '../utils/paths.js'
import { writeFileAtomicSync } from '../utils/atomicWrite.js'
import { ASSIGNABLE_PERMISSIONS, KUBE_LEVELS } from '../config/permissions.js'

// Custom roles of each workspace (orgId → roles). A member's role is either a
// built-in one ('admin', 'operator', 'viewer') or 'custom:<role id>'.
const FILE = path.join(DATA_DIR, 'roles.json')
const RESERVED = ['admin', 'org admin', 'operator', 'viewer', 'super admin', 'superadmin', 'no access']
const bad = (m) => Object.assign(new Error(m), { status: 400 })

export const customRoleKey = (id) => `custom:${id}`
export const customRoleId = (key) => (typeof key === 'string' && key.startsWith('custom:') ? key.slice(7) : null)

class RoleStore {
    _read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
    _write(all) { fs.mkdirSync(DATA_DIR, { recursive: true }); writeFileAtomicSync(FILE, JSON.stringify(all, null, 2)) }

    list(orgId) { return (this._read()[orgId || '_'] || []).slice().sort((a, b) => a.name.localeCompare(b.name)) }
    get(orgId, id) { return this.list(orgId).find(r => r.id === id) || null }

    _clean(orgId, input, selfId) {
        const name = String(input?.name || '').trim().replace(/\s+/g, ' ')
        if (name.length < 2 || name.length > 40) throw bad('Role name: 2 to 40 characters')
        if (!/^[\p{L}\p{N} .&()+/_-]+$/u.test(name)) throw bad('Role name: letters, numbers, spaces and . & ( ) + / _ - only')
        if (RESERVED.includes(name.toLowerCase())) throw bad(`"${name}" is a built-in role — choose another name`)
        if (this.list(orgId).some(r => r.id !== selfId && r.name.toLowerCase() === name.toLowerCase())) throw bad(`A role named "${name}" already exists`)
        const description = String(input?.description || '').trim().slice(0, 200)
        const allowed = ASSIGNABLE_PERMISSIONS()
        const permissions = [...new Set(Array.isArray(input?.permissions) ? input.permissions : [])]
        const unknown = permissions.filter(p => !allowed.includes(p))
        if (unknown.length) throw bad(`Not allowed in a custom role: ${unknown.join(', ')} (team and billing stay with Admins)`)
        if (!permissions.length) throw bad('Pick at least one permission')
        const kube = KUBE_LEVELS.includes(input?.kube) ? input.kube : 'view'
        return { name, description, permissions: permissions.sort(), kube }
    }

    create(orgId, input, by) {
        const all = this._read(); const list = all[orgId || '_'] ||= []
        if (list.length >= 50) throw bad('A workspace can have up to 50 custom roles')
        const role = { id: randomBytes(6).toString('hex'), ...this._clean(orgId, input), createdAt: new Date().toISOString(), createdBy: by || null }
        list.push(role); this._write(all)
        return role
    }

    update(orgId, id, input, by) {
        const all = this._read(); const list = all[orgId || '_'] || []
        const i = list.findIndex(r => r.id === id)
        if (i < 0) throw Object.assign(new Error('Role not found'), { status: 404 })
        list[i] = { ...list[i], ...this._clean(orgId, input, id), updatedAt: new Date().toISOString(), updatedBy: by || null }
        this._write(all)
        return list[i]
    }

    remove(orgId, id) {
        const all = this._read(); const list = all[orgId || '_'] || []
        const i = list.findIndex(r => r.id === id)
        if (i < 0) throw Object.assign(new Error('Role not found'), { status: 404 })
        const [gone] = list.splice(i, 1); this._write(all)
        return gone
    }

    dropOrg(orgId) { const all = this._read(); if (all[orgId]) { delete all[orgId]; this._write(all) } }
}

export const roleStore = new RoleStore()
