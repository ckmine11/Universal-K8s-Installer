// GitOps level 3: a promotion is a pull request. KubeEZ changes values in a
// YAML file of a GitHub repository (e.g. image.tag in apps/web/prod.yaml) on a
// new branch and opens a pull request — Argo CD / Flux deploy it once merged,
// so every change is reviewed and in Git. Comments and layout of the file stay.
import YAML from 'yaml'
import { assertDirectConnectAllowed } from '../utils/netGuard.js'

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/
const FILE = /^(?!\/)(?!.*\.\.)[\w.\-/]{1,300}\.ya?ml$/
const KEY = /^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,7}$/
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

/** A promotion request → checked, or 400. */
export function cleanPromotion(b) {
    if (!REPO.test(String(b?.repo || ''))) throw bad('Repository: owner/name')
    if (!BRANCH.test(String(b?.base || 'main'))) throw bad('Base branch is not valid')
    if (!FILE.test(String(b?.path || ''))) throw bad('File: a .yaml path in the repository (apps/web/prod.yaml)')
    const set = b?.set
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length || Object.keys(set).length > 20) throw bad('set: 1–20 values like {"image.tag": "1.4.2"}')
    for (const [k, v] of Object.entries(set)) {
        if (!KEY.test(k) || k.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw bad(`Not a valid value path: ${k}`)
        if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 200) throw bad(`${k}: a short string, number or true/false`)
    }
    const title = String(b?.title || '').trim().slice(0, 120)
    return { repo: b.repo, base: b.base || 'main', path: b.path, set, title }
}

/** Set the values in YAML text, keeping comments → { text, changes: [{ key, from, to }] } */
export function setInYaml(text, set) {
    const doc = YAML.parseDocument(String(text))
    if (doc.errors.length) throw bad(`The file is not valid YAML: ${doc.errors[0].message.split('\n')[0]}`, 409)
    const changes = []
    for (const [k, v] of Object.entries(set)) {
        const path = k.split('.')
        const from = doc.getIn(path)
        if (from !== undefined && from !== null && typeof from === 'object') throw bad(`${k} is a map or a list in the file, not a value`, 409)
        if (from !== v) { doc.setIn(path, v); changes.push({ key: k, from: from ?? null, to: v }) }
    }
    return { text: doc.toString(), changes }
}

/** Open the pull request. account = { apiUrl, token }. → { url, number, branch, changes } */
export async function openPromotionPr(account, p, { by = 'kubeez', fetchImpl = fetch } = {}) {
    const api = String(account.apiUrl || 'https://api.github.com').replace(/\/+$/, '')
    await assertDirectConnectAllowed(new URL(api).hostname)
    const gh = async (method, path, body) => {
        const r = await fetchImpl(`${api}${path}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { Authorization: `Bearer ${account.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'KubeEZ', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw bad(`GitHub said ${r.status}${d.message ? `: ${String(d.message).slice(0, 200)}` : ''}${r.status === 401 || r.status === 403 ? ' — check the token and its access to this repository' : ''}`, r.status === 404 ? 404 : 502)
        return d
    }
    const enc = (s) => s.split('/').map(encodeURIComponent).join('/')
    const file = await gh('GET', `/repos/${p.repo}/contents/${enc(p.path)}?ref=${encodeURIComponent(p.base)}`)
    if (file.type !== 'file' || typeof file.content !== 'string') throw bad(`${p.path} is not a file`, 409)
    const { text, changes } = setInYaml(Buffer.from(file.content, 'base64').toString('utf8'), p.set)
    if (!changes.length) throw bad(`${p.path} already has these values — nothing to promote`, 409)
    const base = await gh('GET', `/repos/${p.repo}/git/ref/heads/${enc(p.base)}`)
    const branch = `kubeez/promote-${Date.now().toString(36)}`
    await gh('POST', `/repos/${p.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.object.sha })
    const what = changes.map(c => `${c.key}: ${c.from ?? '(none)'} → ${c.to}`).join(', ')
    await gh('PUT', `/repos/${p.repo}/contents/${enc(p.path)}`, { message: `Promote ${p.path}: ${what}`.slice(0, 200), content: Buffer.from(text).toString('base64'), sha: file.sha, branch })
    const pr = await gh('POST', `/repos/${p.repo}/pulls`, {
        title: p.title || `Promote ${p.path}: ${what}`.slice(0, 120), head: branch, base: p.base,
        body: `Opened from KubeEZ by **${String(by).replace(/[^\w.@-]/g, '')}**.\n\n| Value | From | To |\n|---|---|---|\n${changes.map(c => `| \`${c.key}\` | \`${c.from ?? ''}\` | \`${c.to}\` |`).join('\n')}\n\nArgo CD / Flux deploy it once this is merged.`
    })
    return { url: pr.html_url, number: pr.number, branch, changes }
}
