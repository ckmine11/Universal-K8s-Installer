// GitOps level 3: a promotion is a pull request. KubeEZ changes values in a
// YAML file of a Git repository (e.g. image.tag in apps/web/prod.yaml) on a
// new branch and opens a pull request (GitHub, Bitbucket) or merge request
// (GitLab) — Argo CD / Flux deploy it once merged, so every change is reviewed
// and in Git. Comments and layout of the file stay.
import YAML from 'yaml'
import { assertDirectConnectAllowed } from '../utils/netGuard.js'

// provider → its public API address and what a change request is called there
export const PROVIDERS = {
    github: { label: 'GitHub', api: 'https://api.github.com', request: 'pull request', tokenHint: 'a GitHub token (fine-grained, "Contents" and "Pull requests": read and write)' },
    gitlab: { label: 'GitLab', api: 'https://gitlab.com/api/v4', request: 'merge request', tokenHint: 'a GitLab access token with the "api" scope (Developer or higher on the project)' },
    bitbucket: { label: 'Bitbucket', api: 'https://api.bitbucket.org/2.0', request: 'pull request', tokenHint: 'a Bitbucket repository access token, or an app password with your user name (Repositories: write, Pull requests: write)' }
}
// owner/name; GitLab projects may sit in sub-groups (group/sub/name)
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const GITLAB_REPO = /^[A-Za-z0-9_.-]{1,100}(\/[A-Za-z0-9_.-]{1,100}){1,5}$/
const BRANCH = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/
const FILE = /^(?!\/)(?!.*\.\.)[\w.\-/]{1,300}\.ya?ml$/
const KEY = /^[A-Za-z0-9_-]{1,60}(\.[A-Za-z0-9_-]{1,60}){0,7}$/
const bad = (m, status = 400) => Object.assign(new Error(m), { status })

/** A promotion request → checked, or 400. provider decides how a repository is named. */
export function cleanPromotion(b, provider = 'github') {
    const repo = String(b?.repo || '')
    if (!(provider === 'gitlab' ? GITLAB_REPO : REPO).test(repo) || repo.split('/').some(p => p === '.' || p === '..')) throw bad(provider === 'gitlab' ? 'Project: group/name (sub-groups allowed)' : provider === 'bitbucket' ? 'Repository: workspace/name' : 'Repository: owner/name')
    if (!BRANCH.test(String(b?.base || 'main'))) throw bad('Base branch is not valid')
    if (!FILE.test(String(b?.path || ''))) throw bad('File: a .yaml path in the repository (apps/web/prod.yaml)')
    const set = b?.set
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length || Object.keys(set).length > 20) throw bad('set: 1–20 values like {"image.tag": "1.4.2"}')
    for (const [k, v] of Object.entries(set)) {
        if (!KEY.test(k) || k.split('.').some(p => ['__proto__', 'constructor', 'prototype'].includes(p))) throw bad(`Not a valid value path: ${k}`)
        if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 200) throw bad(`${k}: a short string, number or true/false`)
    }
    const title = String(b?.title || '').trim().slice(0, 120)
    return { repo, base: b.base || 'main', path: b.path, set, title }
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

// one HTTP client per provider: its auth header, its error text, JSON or raw text
function client(account, fetchImpl) {
    const provider = account.provider || 'github'
    const P = PROVIDERS[provider]
    const api = String(account.apiUrl || P.api).replace(/\/+$/, '')
    const auth = provider === 'gitlab' ? { 'PRIVATE-TOKEN': account.token }
        : provider === 'bitbucket' && account.username ? { Authorization: `Basic ${Buffer.from(`${account.username}:${account.token}`).toString('base64')}` }
            : { Authorization: `Bearer ${account.token}` }
    const extra = provider === 'github' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : { Accept: 'application/json' }
    return {
        api,
        async call(method, path, body, { raw = false, form = false } = {}) {
            const r = await fetchImpl(`${api}${path}`, {
                method, redirect: 'error', signal: AbortSignal.timeout(20000),
                headers: { ...auth, ...extra, 'User-Agent': 'KubeEZ', ...(body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
                body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined
            })
            if (raw && r.ok) return r.text()
            const text = await r.text().catch(() => '')
            let d = {}
            try { d = text ? JSON.parse(text) : {} } catch { d = {} }
            if (!r.ok) {
                const m = d.message || d.error?.message || d.error_description || (typeof d.error === 'string' ? d.error : null)
                throw bad(`${P.label} said ${r.status}${m ? `: ${String(typeof m === 'object' ? JSON.stringify(m) : m).slice(0, 200)}` : ''}${r.status === 401 || r.status === 403 ? ' — check the token and its access to this repository' : ''}`, r.status === 404 ? 404 : 502)
            }
            return d
        }
    }
}

const prBody = (by, changes) => `Opened from KubeEZ by **${String(by).replace(/[^\w.@-]/g, '')}**.\n\n| Value | From | To |\n|---|---|---|\n${changes.map(c => `| \`${c.key}\` | \`${c.from ?? ''}\` | \`${c.to}\` |`).join('\n')}\n\nArgo CD / Flux deploy it once this is merged.`
const enc = (s) => s.split('/').map(encodeURIComponent).join('/')
const titleOf = (p, what) => p.title || `Promote ${p.path}: ${what}`.slice(0, 120)
const messageOf = (p, what) => `Promote ${p.path}: ${what}`.slice(0, 200)

// GitHub: contents API → branch from base → commit the file → pull request
async function github(c, p, edit, branch, by) {
    const file = await c.call('GET', `/repos/${p.repo}/contents/${enc(p.path)}?ref=${encodeURIComponent(p.base)}`)
    if (file.type !== 'file' || typeof file.content !== 'string') throw bad(`${p.path} is not a file`, 409)
    const { text, changes, what } = edit(Buffer.from(file.content, 'base64').toString('utf8'))
    const base = await c.call('GET', `/repos/${p.repo}/git/ref/heads/${enc(p.base)}`)
    await c.call('POST', `/repos/${p.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.object.sha })
    await c.call('PUT', `/repos/${p.repo}/contents/${enc(p.path)}`, { message: messageOf(p, what), content: Buffer.from(text).toString('base64'), sha: file.sha, branch })
    const pr = await c.call('POST', `/repos/${p.repo}/pulls`, { title: titleOf(p, what), head: branch, base: p.base, body: prBody(by, changes) })
    return { url: pr.html_url, number: pr.number, changes }
}

// GitLab: files API → branch → commit (last_commit_id refuses a file changed meanwhile) → merge request
async function gitlab(c, p, edit, branch, by) {
    const pid = encodeURIComponent(p.repo), fp = encodeURIComponent(p.path)
    const file = await c.call('GET', `/projects/${pid}/repository/files/${fp}?ref=${encodeURIComponent(p.base)}`)
    if (typeof file.content !== 'string') throw bad(`${p.path} is not a file`, 409)
    const { text, changes, what } = edit(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'))
    await c.call('POST', `/projects/${pid}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(p.base)}`)
    await c.call('PUT', `/projects/${pid}/repository/files/${fp}`, { branch, content: text, commit_message: messageOf(p, what), last_commit_id: file.last_commit_id })
    const mr = await c.call('POST', `/projects/${pid}/merge_requests`, { source_branch: branch, target_branch: p.base, title: titleOf(p, what), description: prBody(by, changes), remove_source_branch: true })
    return { url: mr.web_url, number: mr.iid, changes }
}

// Bitbucket Cloud: the base commit → the file at that commit → branch → commit (a form) → pull request
async function bitbucket(c, p, edit, branch, by) {
    const base = await c.call('GET', `/repositories/${p.repo}/refs/branches/${enc(p.base)}`)
    const hash = base?.target?.hash
    if (!hash) throw bad(`Branch ${p.base} not found`, 404)
    const { text, changes, what } = edit(await c.call('GET', `/repositories/${p.repo}/src/${hash}/${enc(p.path)}`, null, { raw: true }))
    await c.call('POST', `/repositories/${p.repo}/refs/branches`, { name: branch, target: { hash } })
    await c.call('POST', `/repositories/${p.repo}/src`, { [p.path]: text, message: messageOf(p, what), branch, parents: hash }, { form: true })
    const pr = await c.call('POST', `/repositories/${p.repo}/pullrequests`, { title: titleOf(p, what), description: prBody(by, changes), source: { branch: { name: branch } }, destination: { branch: { name: p.base } }, close_source_branch: true })
    return { url: pr.links?.html?.href || null, number: pr.id, changes }
}

/** Open the pull / merge request. account = { provider, apiUrl, token, username? } → { url, number, branch, changes, provider } */
export async function openPromotionPr(account, p, { by = 'kubeez', fetchImpl = fetch } = {}) {
    const provider = account.provider || 'github'
    if (!PROVIDERS[provider]) throw bad(`Unknown Git provider ${provider}`)
    const c = client(account, fetchImpl)
    await assertDirectConnectAllowed(new URL(c.api).hostname)
    const edit = (raw) => {
        const r = setInYaml(raw, p.set)
        if (!r.changes.length) throw bad(`${p.path} already has these values — nothing to promote`, 409)
        return { ...r, what: r.changes.map(x => `${x.key}: ${x.from ?? '(none)'} → ${x.to}`).join(', ') }
    }
    const branch = `kubeez/promote-${Date.now().toString(36)}`
    const out = await { github, gitlab, bitbucket }[provider](c, p, edit, branch, by)
    return { ...out, branch, provider }
}
