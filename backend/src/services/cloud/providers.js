// The cloud APIs of managed Kubernetes: read a cluster's version and node
// pools, scale a pool, upgrade the control plane / a pool. One object per
// provider, all with the same shape:
//
//   fields       what the user enters: `ref` (where the cluster is) and `creds`
//   test(a)      → { identity }               the credentials work for this cluster
//   overview(a)  → { version, status, upgrades: [..], pools: [..], notes? }
//   scale(a, poolId, { count } | { min, max })
//   upgrade(a, version)                       the control plane
//   upgradePool(a, poolId, version)           null when the provider upgrades pools with the cluster
//
// a = { ref, creds }. A pool: { id, name, count, min, max, autoscale, machine,
// version, status, busy, perZone? }. No SDKs — signed HTTPS calls (sign.js).
import crypto from 'crypto'
import { sigv4, googleJwt, ociSign } from './sign.js'

// tests point the calls at a mock server (the real URL is still what is signed)
let rewrite = null
export function setCloudEndpointOverride(fn) { rewrite = fn }

const bad = (m, status = 400, hint = null) => Object.assign(new Error(m), { status, hint })
const need = (v, name, re = /^[\w.:\-]{1,256}$/) => {
    const s = String(v ?? '').trim()
    if (!s) throw bad(`${name} is required`)
    if (!re.test(s)) throw bad(`${name} is not valid`)
    return s
}
const REGION = /^[a-z]{2,}(-[a-z0-9]+){1,4}$/

async function call(url, { method = 'GET', headers = {}, body = null, provider }) {
    const target = rewrite ? rewrite(url) : url
    let r
    try {
        r = await fetch(target, { method, headers, body: body ?? undefined, signal: AbortSignal.timeout(25000), redirect: 'error' })
    } catch (e) {
        throw bad(`Could not reach the ${provider} API: ${e.cause?.code || e.message}`, 502)
    }
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!r.ok) {
        const msg = errorText(data) || `HTTP ${r.status}`
        const denied = r.status === 401 || r.status === 403
        throw bad(`${provider}: ${msg}`, denied ? 403 : r.status === 404 ? 404 : r.status === 409 || r.status === 412 ? 409 : r.status === 429 ? 429 : 502,
            denied ? 'The cloud account was refused — check its permissions against the setup guide.' : r.status === 404 ? 'Check where the cluster is (name / region / ID).' : null)
    }
    return { data, headers: r.headers }
}
const errorText = (d) => {
    if (!d) return ''
    if (typeof d === 'string') return (d.match(/<Message>([^<]+)<\/Message>/)?.[1] || d).slice(0, 300)
    return String(d.error?.message || d.error_description || (typeof d.error === 'string' ? d.error : '') || d.message || d.errors?.[0]?.reason || d.Message || '').slice(0, 300)
}

// ── versions ──
const parts = (v) => String(v || '').replace(/^v/, '').split(/[.+-]/).map(n => parseInt(n, 10) || 0)
export const cmpVersion = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0 }
const minor = (v) => parts(v).slice(0, 2).join('.')
/** Newer versions, at most one minor ahead (what EKS, GKE and LKE allow in one step). */
export function nextVersions(current, list) {
    const [ma, mi] = parts(current)
    return [...new Set(list)].filter(v => cmpVersion(v, current) > 0 && parts(v)[0] === ma && parts(v)[1] <= mi + 1).sort((a, b) => cmpVersion(b, a))
}

// ═══ Amazon EKS ═════════════════════════════════════════════════════════════
const ekscreds = new Map()   // assumed-role credentials, cached until shortly before they end
async function awsCreds({ creds, ref }) {
    const base = { accessKeyId: need(creds.accessKeyId, 'Access key ID', /^[A-Z0-9]{16,128}$/), secretAccessKey: need(creds.secretAccessKey, 'Secret access key', /^\S{16,128}$/) }
    if (!creds.roleArn) return base
    const roleArn = need(creds.roleArn, 'Role ARN', /^arn:aws[\w-]*:iam::\d{12}:role\/[\w+=,.@\/-]{1,512}$/)
    const key = crypto.createHash('sha256').update(`${base.accessKeyId}|${base.secretAccessKey}|${roleArn}|${creds.externalId || ''}`).digest('hex')
    const hit = ekscreds.get(key)
    if (hit && hit.until > Date.now() + 120e3) return hit.creds
    const region = need(ref.region, 'Region', REGION)
    const body = new URLSearchParams({ Action: 'AssumeRole', Version: '2011-06-15', RoleArn: roleArn, RoleSessionName: 'kubeez', DurationSeconds: '3600', ...(creds.externalId ? { ExternalId: String(creds.externalId) } : {}) }).toString()
    const url = `https://sts.${region}.amazonaws.com/`
    const headers = sigv4({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' }, body }, base, { region, service: 'sts' })
    const { data } = await call(url, { method: 'POST', headers: clean(headers), body, provider: 'AWS STS' })
    const c = typeof data === 'string'
        ? { AccessKeyId: data.match(/<AccessKeyId>([^<]+)/)?.[1], SecretAccessKey: data.match(/<SecretAccessKey>([^<]+)/)?.[1], SessionToken: data.match(/<SessionToken>([^<]+)/)?.[1], Expiration: data.match(/<Expiration>([^<]+)/)?.[1] }
        : data?.AssumeRoleResponse?.AssumeRoleResult?.Credentials
    if (!c?.AccessKeyId) throw bad('AWS STS: AssumeRole returned no credentials', 502)
    const out = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken }
    const exp = typeof c.Expiration === 'number' ? c.Expiration * 1000 : Date.parse(c.Expiration)
    ekscreds.set(key, { creds: out, until: exp || Date.now() + 3600e3 })
    return out
}
const clean = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith('_') && k !== 'host'))
async function eksCall(a, method, path, body = null) {
    const region = need(a.ref.region, 'Region', REGION)
    const url = `https://eks.${region}.amazonaws.com${path}`
    const json = body ? JSON.stringify(body) : ''
    const headers = sigv4({ method, url, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: json }, await awsCreds(a), { region, service: 'eks' })
    return (await call(url, { method, headers: clean(headers), body: json || null, provider: 'Amazon EKS' })).data
}
const eksName = (a) => encodeURIComponent(need(a.ref.clusterName, 'Cluster name', /^[0-9A-Za-z][A-Za-z0-9\-_]{0,99}$/))
const EKS_BUSY = ['CREATING', 'UPDATING', 'DELETING']

const eks = {
    id: 'eks', name: 'Amazon EKS',
    fields: {
        ref: [{ key: 'region', label: 'Region', placeholder: 'us-east-1' }, { key: 'clusterName', label: 'Cluster name', fromCluster: true }],
        creds: [{ key: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA…' }, { key: 'secretAccessKey', label: 'Secret access key', secret: true }, { key: 'roleArn', label: 'Role to assume (optional)', placeholder: 'arn:aws:iam::123456789012:role/kubeez', optional: true }, { key: 'externalId', label: 'External ID (optional)', optional: true }]
    },
    async test(a) {
        const c = (await eksCall(a, 'GET', `/clusters/${eksName(a)}`)).cluster
        return { identity: a.creds.roleArn ? `role ${a.creds.roleArn.split('/').pop()}` : `key ${String(a.creds.accessKeyId).slice(0, 8)}…`, version: c?.version }
    },
    async overview(a) {
        const name = eksName(a)
        const c = (await eksCall(a, 'GET', `/clusters/${name}`)).cluster || {}
        const names = []
        let next = null
        do { const r = await eksCall(a, 'GET', `/clusters/${name}/node-groups?maxResults=100${next ? `&nextToken=${encodeURIComponent(next)}` : ''}`); names.push(...(r.nodegroups || [])); next = r.nextToken } while (next && names.length < 500)
        const pools = await Promise.all(names.map(async (n) => {
            const g = (await eksCall(a, 'GET', `/clusters/${name}/node-groups/${encodeURIComponent(n)}`)).nodegroup || {}
            const s = g.scalingConfig || {}
            return { id: g.nodegroupName || n, name: g.nodegroupName || n, count: s.desiredSize ?? null, min: s.minSize ?? null, max: s.maxSize ?? null, autoscale: false, machine: (g.instanceTypes || []).join(', ') || null, version: g.version || null, release: g.releaseVersion || null, status: g.status || null, busy: EKS_BUSY.includes(g.status), capacity: g.capacityType || null, problems: (g.health?.issues || []).map(i => i.message).slice(0, 3) }
        }))
        let versions = []
        try { versions = ((await eksCall(a, 'GET', `/cluster-versions?maxResults=100`)).clusterVersions || []).map(v => v.clusterVersion).filter(Boolean) } catch { }
        if (!versions.length && c.version) { const [ma, mi] = parts(c.version); versions = [`${ma}.${mi + 1}`] }
        return { version: c.version || null, platform: c.platformVersion || null, status: c.status || null, busy: EKS_BUSY.includes(c.status), upgrades: nextVersions(c.version, versions).filter(v => minor(v) !== minor(c.version)), pools, notes: ['EKS upgrades the control plane one minor version at a time; node groups follow it (they may not be newer).', 'Cluster Autoscaler / Karpenter, if you run one, changes the desired size within min–max.'] }
    },
    async scale(a, pool, { count, min, max }) {
        const name = eksName(a)
        const g = (await eksCall(a, 'GET', `/clusters/${name}/node-groups/${encodeURIComponent(pool)}`)).nodegroup
        const s = g?.scalingConfig || {}
        const want = { minSize: min ?? Math.min(s.minSize ?? 0, count ?? s.desiredSize), maxSize: max ?? Math.max(s.maxSize ?? 1, count ?? s.desiredSize), desiredSize: count ?? s.desiredSize }
        if (want.desiredSize < want.minSize) want.desiredSize = want.minSize
        if (want.desiredSize > want.maxSize) want.desiredSize = want.maxSize
        const r = await eksCall(a, 'POST', `/clusters/${name}/node-groups/${encodeURIComponent(pool)}/update-config`, { scalingConfig: want, clientRequestToken: crypto.randomUUID() })
        return { operation: r.update?.id || null, size: want }
    },
    async upgrade(a, version) {
        const r = await eksCall(a, 'POST', `/clusters/${eksName(a)}/updates`, { version, clientRequestToken: crypto.randomUUID() })
        return { operation: r.update?.id || null }
    },
    async upgradePool(a, pool, version) {
        const r = await eksCall(a, 'POST', `/clusters/${eksName(a)}/node-groups/${encodeURIComponent(pool)}/update-version`, { version, clientRequestToken: crypto.randomUUID() })
        return { operation: r.update?.id || null }
    },
    setup: (ref) => ({
        intro: 'An IAM user (or a role KubeEZ assumes) that may only read and update this cluster and its node groups.',
        commands: [
            `cat > kubeez-eks.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": ["eks:DescribeCluster", "eks:ListNodegroups", "eks:DescribeNodegroup", "eks:DescribeUpdate", "eks:UpdateClusterVersion", "eks:UpdateNodegroupConfig", "eks:UpdateNodegroupVersion"],
    "Resource": ["arn:aws:eks:${ref.region || '<region>'}:<account-id>:cluster/${ref.clusterName || '<cluster>'}", "arn:aws:eks:${ref.region || '<region>'}:<account-id>:nodegroup/${ref.clusterName || '<cluster>'}/*/*"] },
  { "Effect": "Allow", "Action": ["eks:DescribeClusterVersions"], "Resource": "*" } ] }
EOF`,
            'aws iam create-user --user-name kubeez',
            'aws iam put-user-policy --user-name kubeez --policy-name kubeez-eks --policy-document file://kubeez-eks.json',
            'aws iam create-access-key --user-name kubeez'
        ],
        after: 'Paste the AccessKeyId and SecretAccessKey. (Your organisation prefers roles? Put the policy on a role, let the kubeez user assume it, and enter the role ARN.)'
    })
}

// ═══ Azure AKS ══════════════════════════════════════════════════════════════
const AZ = 'https://management.azure.com'
const AKS_API = 'api-version=2024-09-01'
const tokens = new Map()
async function cachedToken(key, get) {
    const hit = tokens.get(key)
    if (hit && hit.until > Date.now() + 60e3) return hit.token
    const { token, ttl } = await get()
    tokens.set(key, { token, until: Date.now() + (ttl || 3000) * 1000 })
    return token
}
async function azToken({ creds }) {
    const tenant = need(creds.tenantId, 'Tenant ID', /^[\w.-]{1,100}$/)
    const clientId = need(creds.clientId, 'Client (app) ID', /^[\w-]{1,100}$/)
    const secret = need(creds.clientSecret, 'Client secret', /^.{8,512}$/)
    return cachedToken(`az|${tenant}|${clientId}|${crypto.createHash('sha256').update(secret).digest('hex')}`, async () => {
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: `${AZ}/.default` }).toString()
        const { data } = await call(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, provider: 'Microsoft Entra ID' })
        if (!data?.access_token) throw bad('Microsoft Entra ID returned no token', 502)
        return { token: data.access_token, ttl: data.expires_in }
    })
}
const aksPath = (a) => `/subscriptions/${need(a.ref.subscriptionId, 'Subscription ID', /^[0-9a-fA-F-]{36}$/)}/resourceGroups/${encodeURIComponent(need(a.ref.resourceGroup, 'Resource group', /^[\w().-]{1,90}$/))}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(need(a.ref.clusterName, 'Cluster name', /^[\w-]{1,63}$/))}`
async function aksCall(a, method, path, body = null) {
    const json = body ? JSON.stringify(body) : null
    const r = await call(`${AZ}${aksPath(a)}${path}${path.includes('?') ? '&' : '?'}${AKS_API}`, { method, headers: { authorization: `Bearer ${await azToken(a)}`, 'content-type': 'application/json' }, body: json, provider: 'Azure AKS' })
    return r.data
}
const AKS_BUSY = (s) => !!s && !['Succeeded', 'Failed', 'Canceled'].includes(s)
// what a GET returns that a PUT must not send back
const AKS_POOL_RO = ['provisioningState', 'powerState', 'currentOrchestratorVersion', 'nodeImageVersion', 'eTag']
const poolBody = (p) => ({ properties: Object.fromEntries(Object.entries(p.properties || {}).filter(([k]) => !AKS_POOL_RO.includes(k))) })

const aks = {
    id: 'aks', name: 'Azure AKS',
    fields: {
        ref: [{ key: 'subscriptionId', label: 'Subscription ID' }, { key: 'resourceGroup', label: 'Resource group' }, { key: 'clusterName', label: 'Cluster name', fromCluster: true }],
        creds: [{ key: 'tenantId', label: 'Tenant ID' }, { key: 'clientId', label: 'Client (app) ID' }, { key: 'clientSecret', label: 'Client secret', secret: true }]
    },
    async test(a) {
        const c = await aksCall(a, 'GET', '')
        return { identity: `app ${String(a.creds.clientId).slice(0, 8)}…`, version: c?.properties?.currentKubernetesVersion || c?.properties?.kubernetesVersion }
    },
    async overview(a) {
        const [c, up, list] = await Promise.all([aksCall(a, 'GET', ''), aksCall(a, 'GET', '/upgradeProfiles/default').catch(() => null), aksCall(a, 'GET', '/agentPools')])
        const p = c?.properties || {}
        const upPools = Object.fromEntries((up?.properties?.agentPoolProfiles || []).map(x => [x.name, (x.upgrades || []).map(u => u.kubernetesVersion)]))
        const pools = (list?.value || []).map(x => {
            const q = x.properties || {}
            return { id: x.name, name: x.name, count: q.count ?? null, min: q.minCount ?? null, max: q.maxCount ?? null, autoscale: !!q.enableAutoScaling, machine: q.vmSize || null, version: q.currentOrchestratorVersion || q.orchestratorVersion || null, status: q.provisioningState || null, busy: AKS_BUSY(q.provisioningState), mode: q.mode || null, os: q.osType || null, upgrades: upPools[x.name] || [] }
        })
        return {
            version: p.currentKubernetesVersion || p.kubernetesVersion || null, status: p.provisioningState || null, power: p.powerState?.code || null, busy: AKS_BUSY(p.provisioningState),
            upgrades: (up?.properties?.controlPlaneProfile?.upgrades || []).filter(u => !u.isPreview).map(u => u.kubernetesVersion).sort((x, y) => cmpVersion(y, x)),
            pools, notes: ['A pool with the autoscaler on is scaled by changing its min–max.', 'Upgrading the control plane here leaves the node pools as they are — upgrade each pool after it.']
        }
    },
    async scale(a, pool, { count, min, max }) {
        const p = await aksCall(a, 'GET', `/agentPools/${encodeURIComponent(pool)}`)
        const body = poolBody(p)
        if (body.properties.enableAutoScaling) {
            if (min == null || max == null) throw bad('This pool uses the autoscaler — set its min and max instead of a size.')
            Object.assign(body.properties, { minCount: min, maxCount: max })
        } else {
            if (count == null) throw bad('A node count is required')
            body.properties.count = count
        }
        await aksCall(a, 'PUT', `/agentPools/${encodeURIComponent(pool)}`, body)
        return { operation: null }
    },
    async upgrade(a, version) {
        const c = await aksCall(a, 'GET', '')
        const props = { ...(c.properties || {}) }
        for (const k of ['provisioningState', 'powerState', 'fqdn', 'azurePortalFQDN', 'privateFQDN', 'currentKubernetesVersion', 'maxAgentPools']) delete props[k]
        props.kubernetesVersion = version
        // the pools stay as they are (control plane only)
        props.agentPoolProfiles = (props.agentPoolProfiles || []).map(x => Object.fromEntries(Object.entries(x).filter(([k]) => !AKS_POOL_RO.includes(k))))
        await aksCall(a, 'PUT', '', { location: c.location, ...(c.identity ? { identity: c.identity } : {}), ...(c.sku ? { sku: c.sku } : {}), ...(c.tags ? { tags: c.tags } : {}), properties: props })
        return { operation: null }
    },
    async upgradePool(a, pool, version) {
        const p = await aksCall(a, 'GET', `/agentPools/${encodeURIComponent(pool)}`)
        const body = poolBody(p)
        body.properties.orchestratorVersion = version
        await aksCall(a, 'PUT', `/agentPools/${encodeURIComponent(pool)}`, body)
        return { operation: null }
    },
    setup: (ref) => ({
        intro: 'A service principal that may manage this one AKS cluster (its role is scoped to the cluster, not the subscription).',
        commands: [
            `az ad sp create-for-rbac --name kubeez-${ref.clusterName || '<cluster>'} --role "Azure Kubernetes Service Contributor Role" --scopes /subscriptions/${ref.subscriptionId || '<subscription-id>'}/resourceGroups/${ref.resourceGroup || '<resource-group>'}/providers/Microsoft.ContainerService/managedClusters/${ref.clusterName || '<cluster>'}`
        ],
        after: 'It prints appId (Client ID), password (Client secret) and tenant (Tenant ID) — paste them.'
    })
}

// ═══ Google GKE ═════════════════════════════════════════════════════════════
const GKE = 'https://container.googleapis.com/v1'
function gcpAccount(creds) {
    let sa = creds.serviceAccountJson
    if (typeof sa === 'string') { try { sa = JSON.parse(sa) } catch { throw bad('The service account key is not JSON — paste the whole key file.') } }
    if (sa?.type !== 'service_account' || !sa.client_email || !sa.private_key) throw bad('Paste a service account key file (type "service_account", with client_email and private_key).')
    return sa
}
async function gcpToken({ creds }) {
    const sa = gcpAccount(creds)
    return cachedToken(`gcp|${sa.client_email}|${sa.private_key_id || ''}`, async () => {
        // always Google's own token endpoint — never the one the file names
        const url = 'https://oauth2.googleapis.com/token'
        const assertion = googleJwt({ ...sa, token_uri: url })
        const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString()
        const { data } = await call(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, provider: 'Google OAuth' })
        if (!data?.access_token) throw bad('Google returned no token', 502)
        return { token: data.access_token, ttl: data.expires_in }
    })
}
const gkeLoc = (a) => `projects/${need(a.ref.project, 'Project ID', /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/)}/locations/${need(a.ref.location, 'Location (region or zone)', /^[a-z]+-[a-z]+\d(-[a-z])?$/)}`
const gkePath = (a) => `${gkeLoc(a)}/clusters/${need(a.ref.clusterName, 'Cluster name', /^[a-z]([-a-z0-9]{0,38}[a-z0-9])?$/)}`
async function gkeCall(a, method, path, body = null) {
    const json = body ? JSON.stringify(body) : null
    return (await call(`${GKE}/${path}`, { method, headers: { authorization: `Bearer ${await gcpToken(a)}`, 'content-type': 'application/json' }, body: json, provider: 'Google GKE' })).data
}
const GKE_BUSY = ['PROVISIONING', 'RECONCILING', 'STOPPING']

const gke = {
    id: 'gke', name: 'Google GKE',
    fields: {
        ref: [{ key: 'project', label: 'Project ID' }, { key: 'location', label: 'Location (region or zone)', placeholder: 'europe-west1' }, { key: 'clusterName', label: 'Cluster name', fromCluster: true }],
        creds: [{ key: 'serviceAccountJson', label: 'Service account key (JSON)', secret: true, multiline: true }]
    },
    async test(a) {
        const c = await gkeCall(a, 'GET', gkePath(a))
        return { identity: gcpAccount(a.creds).client_email, version: c?.currentMasterVersion }
    },
    async overview(a) {
        const [c, cfg] = await Promise.all([gkeCall(a, 'GET', gkePath(a)), gkeCall(a, 'GET', `${gkeLoc(a)}/serverConfig`).catch(() => null)])
        const zones = (p) => (p.locations || c.locations || []).length || 1
        const pools = (c.nodePools || []).map(p => ({
            id: p.name, name: p.name, perZone: zones(p) > 1 ? zones(p) : null,
            count: p.autoscaling?.enabled ? null : (p.initialNodeCount ?? null), min: p.autoscaling?.minNodeCount ?? p.autoscaling?.totalMinNodeCount ?? null, max: p.autoscaling?.maxNodeCount ?? p.autoscaling?.totalMaxNodeCount ?? null,
            autoscale: !!p.autoscaling?.enabled, machine: p.config?.machineType || null, version: p.version || null, status: p.status || null, busy: GKE_BUSY.includes(p.status), image: p.config?.imageType || null
        }))
        const autopilot = !!c.autopilot?.enabled
        return {
            version: c.currentMasterVersion || null, status: c.status || null, busy: GKE_BUSY.includes(c.status), channel: c.releaseChannel?.channel || null, autopilot,
            upgrades: nextVersions(c.currentMasterVersion, cfg?.validMasterVersions || []),
            nodeVersions: cfg?.validNodeVersions || [], pools: autopilot ? [] : pools,
            notes: [
                ...(autopilot ? ['Autopilot: Google runs the nodes — there are no node pools to scale.'] : []),
                'A pool in several zones: its size is per zone (the cluster gets size × zones nodes). The size shown is the size it was created with — the live count is on the Nodes tab.',
                ...(c.releaseChannel?.channel && c.releaseChannel.channel !== 'UNSPECIFIED' ? [`On the ${c.releaseChannel.channel} release channel Google upgrades automatically; an upgrade here only goes sooner.`] : [])
            ]
        }
    },
    async scale(a, pool, { count, min, max }) {
        const path = `${gkePath(a)}/nodePools/${encodeURIComponent(pool)}`
        if (min != null && max != null) {
            const r = await gkeCall(a, 'POST', `${path}:setAutoscaling`, { autoscaling: { enabled: true, minNodeCount: min, maxNodeCount: max } })
            return { operation: r?.name || null }
        }
        const r = await gkeCall(a, 'POST', `${path}:setSize`, { nodeCount: count })
        return { operation: r?.name || null }
    },
    async upgrade(a, version) {
        const r = await gkeCall(a, 'POST', `${gkePath(a)}:updateMaster`, { masterVersion: version })
        return { operation: r?.name || null }
    },
    async upgradePool(a, pool, version) {
        const path = `${gkePath(a)}/nodePools/${encodeURIComponent(pool)}`
        const p = await gkeCall(a, 'GET', path)
        const r = await gkeCall(a, 'POST', `${path}:update`, { nodeVersion: version, imageType: p?.config?.imageType || 'COS_CONTAINERD' })
        return { operation: r?.name || null }
    },
    setup: (ref) => ({
        intro: 'A service account with the Kubernetes Engine Cluster Admin role — it manages clusters and node pools, not the workloads in them.',
        commands: [
            `gcloud iam service-accounts create kubeez --project ${ref.project || '<project>'} --display-name KubeEZ`,
            `gcloud projects add-iam-policy-binding ${ref.project || '<project>'} --member serviceAccount:kubeez@${ref.project || '<project>'}.iam.gserviceaccount.com --role roles/container.clusterAdmin`,
            `gcloud iam service-accounts keys create kubeez-key.json --iam-account kubeez@${ref.project || '<project>'}.iam.gserviceaccount.com`
        ],
        after: 'Paste the content of kubeez-key.json. (A node pool upgrade that says it may not "act as" the node service account also needs roles/iam.serviceAccountUser on that account.)'
    })
}

// ═══ Oracle OKE ═════════════════════════════════════════════════════════════
const okeBase = (a) => `https://containerengine.${need(a.ref.region, 'Region', REGION)}.oraclecloud.com/20180222`
const ocid = (v, name) => need(v, name, /^ocid1\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9-]*\.[a-z0-9]+$/)
function ociCreds({ creds }) {
    const key = String(creds.privateKey || '').trim()
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw bad('Paste the API key\'s private key (PEM).')
    return { tenancy: ocid(creds.tenancy, 'Tenancy OCID'), user: ocid(creds.user, 'User OCID'), fingerprint: need(creds.fingerprint, 'Fingerprint', /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/), privateKey: key }
}
async function okeCall(a, method, path, body = null) {
    const url = `${okeBase(a)}${path}`
    const json = body ? JSON.stringify(body) : ''
    const headers = ociSign({ method, url, headers: { accept: 'application/json' }, body: json }, ociCreds(a))
    const r = await call(url, { method, headers: clean(headers), body: json || null, provider: 'Oracle OKE' })
    return { data: r.data, work: r.headers.get('opc-work-request-id') }
}
const OKE_BUSY = ['CREATING', 'UPDATING', 'DELETING']

const oke = {
    id: 'oke', name: 'Oracle OKE',
    fields: {
        ref: [{ key: 'region', label: 'Region', placeholder: 'eu-frankfurt-1' }, { key: 'clusterId', label: 'Cluster OCID', placeholder: 'ocid1.cluster.oc1…' }],
        creds: [{ key: 'tenancy', label: 'Tenancy OCID' }, { key: 'user', label: 'User OCID' }, { key: 'fingerprint', label: 'API key fingerprint', placeholder: 'aa:bb:…' }, { key: 'privateKey', label: 'API private key (PEM)', secret: true, multiline: true }]
    },
    async test(a) {
        const { data } = await okeCall(a, 'GET', `/clusters/${ocid(a.ref.clusterId, 'Cluster OCID')}`)
        return { identity: `user …${String(a.creds.user).slice(-8)}`, version: data?.kubernetesVersion }
    },
    async overview(a) {
        const id = ocid(a.ref.clusterId, 'Cluster OCID')
        const c = (await okeCall(a, 'GET', `/clusters/${id}`)).data || {}
        const list = (await okeCall(a, 'GET', `/nodePools?compartmentId=${encodeURIComponent(c.compartmentId)}&clusterId=${encodeURIComponent(id)}`)).data || []
        const pools = list.map(p => ({ id: p.id, name: p.name, count: p.nodeConfigDetails?.size ?? (p.quantityPerSubnet != null ? p.quantityPerSubnet * (p.subnetIds || []).length : null), min: null, max: null, autoscale: false, machine: p.nodeShape || null, version: p.kubernetesVersion || null, status: p.lifecycleState || null, busy: OKE_BUSY.includes(p.lifecycleState) }))
        return { version: c.kubernetesVersion || null, status: c.lifecycleState || null, busy: OKE_BUSY.includes(c.lifecycleState), type: c.type || null, upgrades: (c.availableKubernetesUpgrades || []).sort((x, y) => cmpVersion(y, x)), pools, notes: ['A node pool upgrade replaces its nodes one at a time (node cycling: one extra node, none unavailable).'] }
    },
    async scale(a, pool, { count }) {
        if (count == null) throw bad('A node count is required')
        const p = (await okeCall(a, 'GET', `/nodePools/${ocid(pool, 'Node pool')}`)).data || {}
        const r = await okeCall(a, 'PUT', `/nodePools/${ocid(pool, 'Node pool')}`, { nodeConfigDetails: { size: count, ...(p.nodeConfigDetails?.placementConfigs ? { placementConfigs: p.nodeConfigDetails.placementConfigs } : {}) } })
        return { operation: r.work }
    },
    async upgrade(a, version) {
        const r = await okeCall(a, 'PUT', `/clusters/${ocid(a.ref.clusterId, 'Cluster OCID')}`, { kubernetesVersion: version })
        return { operation: r.work }
    },
    async upgradePool(a, pool, version) {
        const r = await okeCall(a, 'PUT', `/nodePools/${ocid(pool, 'Node pool')}`, { kubernetesVersion: version, nodePoolCyclingDetails: { isNodeCyclingEnabled: true, maximumSurge: '1', maximumUnavailable: '0' } })
        return { operation: r.work }
    },
    setup: () => ({
        intro: 'An OCI user in its own group, with an API key, allowed to manage clusters in the cluster\'s compartment.',
        commands: [
            'oci iam group create --name kubeez --description "KubeEZ"',
            'oci iam user create --name kubeez --description "KubeEZ"',
            'oci iam group add-user --group-id <group-ocid> --user-id <user-ocid>',
            'oci iam policy create --compartment-id <compartment-ocid> --name kubeez --description "KubeEZ" --statements \'["Allow group kubeez to manage cluster-family in compartment <compartment>", "Allow group kubeez to manage instance-family in compartment <compartment>", "Allow group kubeez to use subnets in compartment <compartment>", "Allow group kubeez to use vnics in compartment <compartment>", "Allow group kubeez to inspect compartments in compartment <compartment>"]\'',
            'openssl genrsa -out kubeez-oci.pem 2048 && openssl rsa -pubout -in kubeez-oci.pem -out kubeez-oci-public.pem',
            'oci iam user api-key upload --user-id <user-ocid> --key-file kubeez-oci-public.pem'
        ],
        after: 'Paste the tenancy and user OCIDs, the fingerprint the upload printed, and kubeez-oci.pem.'
    })
}

// ═══ DigitalOcean DOKS ══════════════════════════════════════════════════════
const DO = 'https://api.digitalocean.com/v2/kubernetes/clusters'
const bearer = (t, name) => ({ authorization: `Bearer ${need(t, name, /^[\w.\-:]{10,512}$/)}`, 'content-type': 'application/json' })
const doCall = async (a, method, path, body = null) => (await call(`${DO}/${need(a.ref.clusterId, 'Cluster ID', /^[0-9a-f-]{36}$/)}${path}`, { method, headers: bearer(a.creds.token, 'API token'), body: body ? JSON.stringify(body) : null, provider: 'DigitalOcean' })).data

const doks = {
    id: 'doks', name: 'DigitalOcean DOKS',
    fields: {
        ref: [{ key: 'clusterId', label: 'Cluster ID', placeholder: 'doctl kubernetes cluster list' }],
        creds: [{ key: 'token', label: 'API token (Kubernetes read + update)', secret: true }]
    },
    async test(a) { const c = (await doCall(a, 'GET', '')).kubernetes_cluster; return { identity: 'API token', version: c?.version } },
    async overview(a) {
        const [c, up] = await Promise.all([doCall(a, 'GET', '').then(d => d.kubernetes_cluster || {}), doCall(a, 'GET', '/upgrades').catch(() => null)])
        const pools = (c.node_pools || []).map(p => ({ id: p.id, name: p.name, count: p.count ?? null, min: p.auto_scale ? p.min_nodes : null, max: p.auto_scale ? p.max_nodes : null, autoscale: !!p.auto_scale, machine: p.size || null, version: c.version || null, status: (p.nodes || []).some(n => n.status?.state !== 'running') ? 'provisioning' : 'running', busy: (p.nodes || []).some(n => ['provisioning', 'deleting'].includes(n.status?.state)) }))
        return { version: c.version || null, status: c.status?.state || null, busy: ['provisioning', 'upgrading'].includes(c.status?.state), upgrades: (up?.available_upgrade_versions || []).map(v => v.slug).sort((x, y) => cmpVersion(y, x)), pools, poolUpgrades: false, notes: ['DOKS upgrades the control plane and every node pool together (nodes are replaced one by one).'] }
    },
    async scale(a, pool, { count, min, max }) {
        const p = (await doCall(a, 'GET', `/node_pools/${need(pool, 'Node pool', /^[0-9a-f-]{36}$/)}`)).node_pool || {}
        const body = { name: p.name, count: count ?? p.count, auto_scale: !!p.auto_scale, ...(p.auto_scale ? { min_nodes: min ?? p.min_nodes, max_nodes: max ?? p.max_nodes } : {}) }
        await doCall(a, 'PUT', `/node_pools/${pool}`, body)
        return { operation: null }
    },
    async upgrade(a, version) { await doCall(a, 'POST', '/upgrade', { version }); return { operation: null } },
    upgradePool: null,
    setup: () => ({ intro: 'A custom-scoped API token that may only read and update Kubernetes clusters.', commands: ['DigitalOcean → API → Generate New Token → Custom Scopes: kubernetes (read, update)'], after: 'Paste the token, and the cluster ID from `doctl kubernetes cluster list`.' })
}

// ═══ Akamai / Linode LKE ════════════════════════════════════════════════════
const LKE = 'https://api.linode.com/v4/lke'
const lkeCall = async (a, method, path, body = null) => (await call(`${LKE}${path}`, { method, headers: bearer(a.creds.token, 'API token'), body: body ? JSON.stringify(body) : null, provider: 'Linode LKE' })).data
const lkeId = (a) => need(a.ref.clusterId, 'Cluster ID', /^\d{1,12}$/)

const lke = {
    id: 'lke', name: 'Linode / Akamai LKE',
    fields: {
        ref: [{ key: 'clusterId', label: 'Cluster ID', placeholder: 'linode-cli lke clusters-list' }],
        creds: [{ key: 'token', label: 'Personal access token (Kubernetes read/write)', secret: true }]
    },
    async test(a) { const c = await lkeCall(a, 'GET', `/clusters/${lkeId(a)}`); return { identity: 'personal access token', version: c?.k8s_version } },
    async overview(a) {
        const id = lkeId(a)
        const [c, pools, versions] = await Promise.all([lkeCall(a, 'GET', `/clusters/${id}`), lkeCall(a, 'GET', `/clusters/${id}/pools`), lkeCall(a, 'GET', '/versions').catch(() => null)])
        return {
            version: c.k8s_version || null, status: c.status || null, busy: false,
            upgrades: nextVersions(c.k8s_version, (versions?.data || []).map(v => v.id)),
            pools: (pools?.data || []).map(p => ({ id: String(p.id), name: p.label || `pool ${p.id}`, count: p.count ?? null, min: p.autoscaler?.enabled ? p.autoscaler.min : null, max: p.autoscaler?.enabled ? p.autoscaler.max : null, autoscale: !!p.autoscaler?.enabled, machine: p.type || null, version: c.k8s_version || null, status: (p.nodes || []).every(n => n.status === 'ready') ? 'ready' : 'not ready', busy: (p.nodes || []).some(n => n.status !== 'ready') })),
            poolRecycle: true, notes: ['LKE upgrades the control plane; the nodes get the new version when they are recycled ("Upgrade pool" recycles its nodes one by one).']
        }
    },
    async scale(a, pool, { count, min, max }) {
        const body = min != null && max != null ? { autoscaler: { enabled: true, min, max }, ...(count != null ? { count } : {}) } : { count }
        await lkeCall(a, 'PUT', `/clusters/${lkeId(a)}/pools/${need(pool, 'Node pool', /^\d{1,12}$/)}`, body)
        return { operation: null }
    },
    async upgrade(a, version) { await lkeCall(a, 'PUT', `/clusters/${lkeId(a)}`, { k8s_version: version }); return { operation: null } },
    async upgradePool(a, pool) { await lkeCall(a, 'POST', `/clusters/${lkeId(a)}/pools/${need(pool, 'Node pool', /^\d{1,12}$/)}/recycle`); return { operation: null } },
    setup: () => ({ intro: 'A personal access token with only Kubernetes read/write.', commands: ['Cloud Manager → My Profile → API Tokens → Create a Personal Access Token → Kubernetes: Read/Write (everything else: No Access)'], after: 'Paste the token, and the cluster ID from `linode-cli lke clusters-list`.' })
}

export const CLOUD_APIS = { eks, aks, gke, oke, doks, lke }
export const cloudApiFor = (provider) => CLOUD_APIS[provider] || null
