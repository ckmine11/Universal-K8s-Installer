// Phase 5 — node pools and upgrades through the cloud provider's API (EKS,
// AKS, GKE, OKE, DOKS, LKE). No cloud accounts here: one mock server speaks
// each provider's REST API and CHECKS the signatures the way the provider
// would (SigV4 recomputed, the Google JWT and the OCI signature verified with
// the public key, bearer tokens). AWS's own published example pins SigV4.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'

const { sigv4, googleJwt, ociSign } = await import('../src/services/cloud/sign.js')
const { CLOUD_APIS, setCloudEndpointOverride, nextVersions } = await import('../src/services/cloud/providers.js')
const cloud = await import('../src/services/cloud/cloudAccount.js')
const { capabilities } = await import('../src/services/clusterAccess.js')
const { stripCredentials } = await import('../src/services/clusterCredentials.js')
const { PROTECTED_ACTIONS } = await import('../src/services/approvals.js')
const { clusterStore } = await import('../src/services/clusterStore.js')
const { auditLog } = await import('../src/services/auditLog.js')
const { encrypt } = await import('../src/utils/cryptoUtils.js')

const user = { id: 'u1', username: 'boss', orgId: 'org1' }
const AWS = { accessKeyId: 'AKIAKUBEEZTEST0001', secretAccessKey: 'kubeez-test-secret-key-0123456789' }
const google = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const oracle = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const SA = { type: 'service_account', client_email: 'kubeez@shop-prod.iam.gserviceaccount.com', private_key_id: 'k1', private_key: google.privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://evil.example/token' }
const OCI = { tenancy: 'ocid1.tenancy.oc1..aaaatenancy', user: 'ocid1.user.oc1..aaaauser', fingerprint: '12:34:56:78:9a:bc:de:f0:12:34:56:78:9a:bc:de:f0', privateKey: oracle.privateKey.export({ type: 'pkcs8', format: 'pem' }) }

// ── the mock cloud ──
const calls = []
const state = {}
function reset() {
    Object.assign(state, {
        eks: { version: '1.30', status: 'ACTIVE', groups: { general: { desired: 3, min: 1, max: 5, version: '1.30', status: 'ACTIVE' }, gpu: { desired: 0, min: 0, max: 2, version: '1.29', status: 'ACTIVE' } } },
        aks: { version: '1.29.7', state: 'Succeeded', pools: { system: { count: 3, auto: false, version: '1.29.7', mode: 'System' }, burst: { count: 2, auto: true, min: 1, max: 6, version: '1.28.9', mode: 'User' } } },
        gke: { version: '1.30.5-gke.1014001', status: 'RUNNING', pools: { 'default-pool': { size: 2, version: '1.30.5-gke.1014001', zones: 3 }, batch: { size: 1, version: '1.29.8-gke.1211000', auto: { min: 0, max: 4 }, zones: 3 } } },
        oke: { version: 'v1.30.1', state: 'ACTIVE', pools: { 'ocid1.nodepool.oc1.eu-frankfurt-1.aaaapool1': { name: 'pool1', size: 3, version: 'v1.29.1' } } },
        doks: { version: '1.30.4-do.0', pools: { '11111111-2222-3333-4444-555555555555': { name: 'web', count: 2, auto: false } } },
        lke: { version: '1.30', pools: { 77: { count: 3 } } }
    })
    calls.length = 0
}
reset()
const json = (res, code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
const denied = (res, msg = 'denied') => json(res, 403, { error: { message: msg }, message: msg })

function checkAws(req, url, body, region, service) {
    const auth = req.headers.authorization || ''
    const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/)
    if (!m || m[3] !== region || m[4] !== service) return false
    const signed = m[5].split(';').filter(h => h !== 'host')
    const headers = Object.fromEntries(signed.filter(h => h !== 'x-amz-date' && h !== 'x-amz-security-token').map(h => [h, req.headers[h]]))
    const d = req.headers['x-amz-date']
    const now = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`)
    const secret = m[1] === AWS.accessKeyId ? AWS.secretAccessKey : m[1] === 'ASIAASSUMED000001' ? 'assumed-secret-0123456789abcdef' : null
    if (!secret) return false
    if (m[1].startsWith('ASIA') && req.headers['x-amz-security-token'] !== 'assumed-session-token') return false
    const again = sigv4({ method: req.method, url, headers, body }, { accessKeyId: m[1], secretAccessKey: secret, sessionToken: req.headers['x-amz-security-token'] }, { region, service, now })
    return again._signature === m[6]
}
function checkOci(req, url, body) {
    const a = req.headers.authorization || ''
    const keyId = a.match(/keyId="([^"]+)"/)?.[1], names = a.match(/headers="([^"]+)"/)?.[1]?.split(' '), sig = a.match(/signature="([^"]+)"/)?.[1]
    if (keyId !== `${OCI.tenancy}/${OCI.user}/${OCI.fingerprint}` || !names || !sig) return false
    const u = new URL(url)
    if (['PUT', 'POST'].includes(req.method) && req.headers['x-content-sha256'] !== crypto.createHash('sha256').update(body).digest('base64')) return false
    const str = names.map(n => n === '(request-target)' ? `(request-target): ${req.method.toLowerCase()} ${u.pathname}${u.search}` : n === 'host' ? `host: ${u.host}` : `${n}: ${req.headers[n]}`).join('\n')
    return crypto.verify('RSA-SHA256', Buffer.from(str), oracle.publicKey, Buffer.from(sig, 'base64'))
}

const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', d => body += d)
    req.on('end', () => {
        const [, host, ...rest] = req.url.split('/')
        const url = `https://${host}/${rest.join('/')}`
        const u = new URL(url)
        const p = u.pathname
        calls.push({ method: req.method, host, path: p + u.search, body })
        // ── AWS ──
        if (host === 'sts.eu-west-1.amazonaws.com') {
            if (!checkAws(req, url, body, 'eu-west-1', 'sts')) return denied(res, 'SignatureDoesNotMatch')
            const q = new URLSearchParams(body)
            if (q.get('Action') !== 'AssumeRole' || q.get('RoleArn') !== 'arn:aws:iam::123456789012:role/kubeez') return denied(res)
            res.writeHead(200, { 'content-type': 'text/xml' })
            return res.end(`<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAASSUMED000001</AccessKeyId><SecretAccessKey>assumed-secret-0123456789abcdef</SecretAccessKey><SessionToken>assumed-session-token</SessionToken><Expiration>${new Date(Date.now() + 3600e3).toISOString()}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`)
        }
        if (host === 'eks.eu-west-1.amazonaws.com') {
            if (!checkAws(req, url, body, 'eu-west-1', 'eks')) return json(res, 403, { message: 'The request signature we calculated does not match the signature you provided.' })
            const s = state.eks
            if (p === '/cluster-versions') return json(res, 200, { clusterVersions: ['1.29', '1.30', '1.31', '1.32'].map(v => ({ clusterVersion: v })) })
            if (p !== '/clusters/shop-prod' && !p.startsWith('/clusters/shop-prod/')) return json(res, 404, { message: 'No cluster found for name: x.' })
            if (p === '/clusters/shop-prod') return json(res, 200, { cluster: { name: 'shop-prod', version: s.version, status: s.status, platformVersion: 'eks.7' } })
            if (p === '/clusters/shop-prod/node-groups') return json(res, 200, { nodegroups: Object.keys(s.groups) })
            if (p === '/clusters/shop-prod/updates' && req.method === 'POST') { s.version = JSON.parse(body).version; s.status = 'UPDATING'; return json(res, 200, { update: { id: 'upd-1', status: 'InProgress', type: 'VersionUpdate' } }) }
            const g = p.match(/^\/clusters\/shop-prod\/node-groups\/([^/]+)(\/.*)?$/)
            if (g && s.groups[g[1]]) {
                const ng = s.groups[g[1]]
                if (!g[2]) return json(res, 200, { nodegroup: { nodegroupName: g[1], status: ng.status, version: ng.version, releaseVersion: `${ng.version}.0-2024`, instanceTypes: ['m6i.large'], capacityType: 'ON_DEMAND', scalingConfig: { desiredSize: ng.desired, minSize: ng.min, maxSize: ng.max } } })
                if (g[2] === '/update-config') { const c = JSON.parse(body).scalingConfig; Object.assign(ng, { desired: c.desiredSize, min: c.minSize, max: c.maxSize }); return json(res, 200, { update: { id: 'upd-2' } }) }
                if (g[2] === '/update-version') { ng.version = JSON.parse(body).version; return json(res, 200, { update: { id: 'upd-3' } }) }
            }
            return json(res, 404, { message: 'not found' })
        }
        // ── Azure ──
        if (host === 'login.microsoftonline.com') {
            const q = new URLSearchParams(body)
            if (p !== '/tenant-1/oauth2/v2.0/token' || q.get('client_secret') !== 'az-secret-123' || q.get('scope') !== 'https://management.azure.com/.default') return json(res, 401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' })
            return json(res, 200, { access_token: 'az-access-token', expires_in: 3599 })
        }
        if (host === 'management.azure.com') {
            if (req.headers.authorization !== 'Bearer az-access-token') return json(res, 401, { error: { message: 'InvalidAuthenticationToken' } })
            if (u.searchParams.get('api-version') !== '2024-09-01') return json(res, 400, { error: { message: 'api-version' } })
            const base = '/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/shop/providers/Microsoft.ContainerService/managedClusters/shop-aks'
            if (!p.startsWith(base)) return json(res, 404, { error: { message: 'ResourceNotFound' } })
            const s = state.aks, sub = p.slice(base.length)
            const poolJson = (n) => { const x = s.pools[n]; return { name: n, properties: { count: x.count, vmSize: 'Standard_D4s_v5', enableAutoScaling: x.auto, ...(x.auto ? { minCount: x.min, maxCount: x.max } : {}), orchestratorVersion: x.version, currentOrchestratorVersion: x.version, provisioningState: 'Succeeded', powerState: { code: 'Running' }, mode: x.mode, osType: 'Linux' } } }
            if (sub === '' && req.method === 'GET') return json(res, 200, { location: 'westeurope', identity: { type: 'SystemAssigned' }, sku: { name: 'Base', tier: 'Free' }, properties: { kubernetesVersion: s.version, currentKubernetesVersion: s.version, provisioningState: s.state, powerState: { code: 'Running' }, fqdn: 'x.hcp.westeurope.azmk8s.io', agentPoolProfiles: Object.keys(s.pools).map(n => ({ name: n, ...poolJson(n).properties })) } })
            if (sub === '' && req.method === 'PUT') { const b = JSON.parse(body); if (b.properties.fqdn || b.properties.provisioningState || b.properties.agentPoolProfiles.some(x => x.currentOrchestratorVersion)) return json(res, 400, { error: { message: 'read-only property sent' } }); s.version = b.properties.kubernetesVersion; s.lastPut = b; return json(res, 200, {}) }
            if (sub === '/upgradeProfiles/default') return json(res, 200, { properties: { controlPlaneProfile: { kubernetesVersion: s.version, upgrades: [{ kubernetesVersion: '1.30.3' }, { kubernetesVersion: '1.30.4' }, { kubernetesVersion: '1.31.0', isPreview: true }] }, agentPoolProfiles: [{ name: 'burst', kubernetesVersion: '1.28.9', upgrades: [{ kubernetesVersion: '1.29.7' }] }, { name: 'system', upgrades: [] }] } })
            if (sub === '/agentPools') return json(res, 200, { value: Object.keys(s.pools).map(poolJson) })
            const m = sub.match(/^\/agentPools\/([^/]+)$/)
            if (m && s.pools[m[1]]) {
                if (req.method === 'GET') return json(res, 200, poolJson(m[1]))
                const b = JSON.parse(body).properties
                if (b.provisioningState || b.currentOrchestratorVersion || b.powerState) return json(res, 400, { error: { message: 'read-only property sent' } })
                Object.assign(s.pools[m[1]], { count: b.count, min: b.minCount, max: b.maxCount, version: b.orchestratorVersion })
                return json(res, 200, poolJson(m[1]))
            }
            return json(res, 404, { error: { message: 'ResourceNotFound' } })
        }
        // ── Google ──
        if (host === 'oauth2.googleapis.com') {
            const q = new URLSearchParams(body)
            const [h, c, sig] = String(q.get('assertion')).split('.')
            const ok = sig && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), google.publicKey, Buffer.from(sig, 'base64url'))
            const claims = ok ? JSON.parse(Buffer.from(c, 'base64url').toString()) : {}
            if (!ok || claims.iss !== SA.client_email || claims.aud !== 'https://oauth2.googleapis.com/token' || q.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' })
            return json(res, 200, { access_token: 'gcp-access-token', expires_in: 3599 })
        }
        if (host === 'container.googleapis.com') {
            if (req.headers.authorization !== 'Bearer gcp-access-token') return json(res, 401, { error: { message: 'Request had invalid authentication credentials.' } })
            const s = state.gke, base = '/v1/projects/shop-prod/locations/europe-west1'
            if (p === `${base}/serverConfig`) return json(res, 200, { validMasterVersions: ['1.31.1-gke.1678000', '1.31.0-gke.1000', '1.30.6-gke.1125000', '1.30.5-gke.1014001', '1.32.0-gke.100'], validNodeVersions: ['1.31.1-gke.1678000', '1.30.5-gke.1014001'] })
            const poolJson = (n) => { const x = s.pools[n]; return { name: n, initialNodeCount: x.size, version: x.version, status: 'RUNNING', locations: Array.from({ length: x.zones }, (_, i) => `europe-west1-${'bcd'[i]}`), config: { machineType: 'e2-standard-4', imageType: 'COS_CONTAINERD' }, ...(x.auto ? { autoscaling: { enabled: true, minNodeCount: x.auto.min, maxNodeCount: x.auto.max } } : {}) } }
            if (p === `${base}/clusters/shop-gke` && req.method === 'GET') return json(res, 200, { name: 'shop-gke', currentMasterVersion: s.version, status: s.status, releaseChannel: { channel: 'REGULAR' }, nodePools: Object.keys(s.pools).map(poolJson) })
            if (p === `${base}/clusters/shop-gke:updateMaster`) { s.version = JSON.parse(body).masterVersion; return json(res, 200, { name: 'operation-1', status: 'RUNNING' }) }
            const m = p.match(new RegExp(`^${base}/clusters/shop-gke/nodePools/([^/:]+)(:\\w+)?$`))
            if (m && s.pools[m[1]]) {
                const b = body ? JSON.parse(body) : {}
                if (!m[2]) return json(res, 200, poolJson(m[1]))
                if (m[2] === ':setSize') { s.pools[m[1]].size = b.nodeCount; return json(res, 200, { name: 'operation-2' }) }
                if (m[2] === ':setAutoscaling') { s.pools[m[1]].auto = { min: b.autoscaling.minNodeCount, max: b.autoscaling.maxNodeCount }; return json(res, 200, { name: 'operation-3' }) }
                if (m[2] === ':update') { if (!b.imageType) return json(res, 400, { error: { message: 'imageType required' } }); s.pools[m[1]].version = b.nodeVersion; return json(res, 200, { name: 'operation-4' }) }
            }
            return json(res, 404, { error: { message: 'Not found' } })
        }
        // ── Oracle ──
        if (host === 'containerengine.eu-frankfurt-1.oraclecloud.com') {
            if (!checkOci(req, url, body)) return json(res, 401, { code: 'NotAuthenticated', message: 'The required information to complete authentication was not provided or was incorrect.' })
            const s = state.oke, cid = 'ocid1.cluster.oc1.eu-frankfurt-1.aaaacluster'
            if (p === `/20180222/clusters/${cid}`) {
                if (req.method === 'PUT') { s.version = JSON.parse(body).kubernetesVersion; return json(res, 202, {}, { 'opc-work-request-id': 'ocid1.workrequest.1' }) }
                return json(res, 200, { id: cid, name: 'shop-oke', compartmentId: 'ocid1.compartment.oc1..aaaacomp', kubernetesVersion: s.version, lifecycleState: s.state, type: 'BASIC_CLUSTER', availableKubernetesUpgrades: ['v1.31.1'] })
            }
            if (p === '/20180222/nodePools') {
                if (u.searchParams.get('compartmentId') !== 'ocid1.compartment.oc1..aaaacomp' || u.searchParams.get('clusterId') !== cid) return json(res, 400, { message: 'compartmentId' })
                return json(res, 200, Object.entries(s.pools).map(([id, x]) => ({ id, name: x.name, kubernetesVersion: x.version, nodeShape: 'VM.Standard.A1.Flex', lifecycleState: 'ACTIVE', nodeConfigDetails: { size: x.size } })))
            }
            const m = p.match(/^\/20180222\/nodePools\/(.+)$/)
            if (m && s.pools[m[1]]) {
                if (req.method === 'GET') return json(res, 200, { id: m[1], nodeConfigDetails: { size: s.pools[m[1]].size, placementConfigs: [{ availabilityDomain: 'AD-1', subnetId: 'ocid1.subnet.1' }] } })
                const b = JSON.parse(body)
                if (b.nodeConfigDetails) { if (!b.nodeConfigDetails.placementConfigs) return json(res, 400, { message: 'placementConfigs' }); s.pools[m[1]].size = b.nodeConfigDetails.size }
                if (b.kubernetesVersion) { if (!b.nodePoolCyclingDetails?.isNodeCyclingEnabled) return json(res, 400, { message: 'cycling' }); s.pools[m[1]].version = b.kubernetesVersion }
                return json(res, 202, {}, { 'opc-work-request-id': 'ocid1.workrequest.2' })
            }
            return json(res, 404, { code: 'NotAuthorizedOrNotFound', message: 'Authorization failed or requested resource not found.' })
        }
        // ── DigitalOcean ──
        if (host === 'api.digitalocean.com') {
            if (req.headers.authorization !== 'Bearer dop_v1_testtoken') return json(res, 401, { id: 'Unauthorized', message: 'Unable to authenticate you' })
            const s = state.doks, base = '/v2/kubernetes/clusters/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            if (p === base) return json(res, 200, { kubernetes_cluster: { name: 'shop-do', version: s.version, status: { state: 'running' }, node_pools: Object.entries(s.pools).map(([id, x]) => ({ id, name: x.name, size: 's-2vcpu-4gb', count: x.count, auto_scale: x.auto, nodes: Array.from({ length: x.count }, () => ({ status: { state: 'running' } })) })) } })
            if (p === `${base}/upgrades`) return json(res, 200, { available_upgrade_versions: [{ slug: '1.31.1-do.0', kubernetes_version: '1.31.1' }] })
            if (p === `${base}/upgrade`) { s.version = JSON.parse(body).version; return json(res, 202, {}) }
            const m = p.match(/node_pools\/([^/]+)$/)
            if (m && s.pools[m[1]]) {
                if (req.method === 'GET') return json(res, 200, { node_pool: { id: m[1], name: s.pools[m[1]].name, count: s.pools[m[1]].count, auto_scale: false } })
                const b = JSON.parse(body); if (!b.name) return json(res, 422, { message: 'name is required' })
                s.pools[m[1]].count = b.count; return json(res, 202, {})
            }
            return json(res, 404, { id: 'not_found', message: 'The resource you were accessing could not be found.' })
        }
        // ── Linode ──
        if (host === 'api.linode.com') {
            if (req.headers.authorization !== 'Bearer linode-test-token') return json(res, 401, { errors: [{ reason: 'Invalid Token' }] })
            const s = state.lke
            if (p === '/v4/lke/versions') return json(res, 200, { data: [{ id: '1.32' }, { id: '1.31' }, { id: '1.30' }] })
            if (p === '/v4/lke/clusters/4242') { if (req.method === 'PUT') { s.version = JSON.parse(body).k8s_version; return json(res, 200, {}) } return json(res, 200, { id: 4242, label: 'shop-lke', k8s_version: s.version, status: 'ready' }) }
            if (p === '/v4/lke/clusters/4242/pools') return json(res, 200, { data: Object.entries(s.pools).map(([id, x]) => ({ id: +id, type: 'g6-standard-2', count: x.count, autoscaler: { enabled: false }, nodes: Array.from({ length: x.count }, () => ({ status: 'ready' })) })) })
            if (p === '/v4/lke/clusters/4242/pools/77' && req.method === 'PUT') { s.pools[77].count = JSON.parse(body).count; return json(res, 200, {}) }
            if (p === '/v4/lke/clusters/4242/pools/77/recycle') { s.pools[77].recycled = true; return json(res, 200, {}) }
            return json(res, 404, { errors: [{ reason: 'Not found' }] })
        }
        json(res, 599, { message: `unexpected host ${host}` })
    })
})
let base
before(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${server.address().port}`
    setCloudEndpointOverride((u) => u.replace(/^https:\/\//, `${base}/`))
})
after(() => { setCloudEndpointOverride(null); server.close(); fs.rmSync(DATA, { recursive: true, force: true }) })

const A = {
    eks: { ref: { region: 'eu-west-1', clusterName: 'shop-prod' }, creds: AWS },
    aks: { ref: { subscriptionId: '00000000-1111-2222-3333-444444444444', resourceGroup: 'shop', clusterName: 'shop-aks' }, creds: { tenantId: 'tenant-1', clientId: 'app-1234-5678', clientSecret: 'az-secret-123' } },
    gke: { ref: { project: 'shop-prod', location: 'europe-west1', clusterName: 'shop-gke' }, creds: { serviceAccountJson: JSON.stringify(SA) } },
    oke: { ref: { region: 'eu-frankfurt-1', clusterId: 'ocid1.cluster.oc1.eu-frankfurt-1.aaaacluster' }, creds: OCI },
    doks: { ref: { clusterId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, creds: { token: 'dop_v1_testtoken' } },
    lke: { ref: { clusterId: '4242' }, creds: { token: 'linode-test-token' } }
}

describe('signing', () => {
    test('SigV4 gives AWS\'s own published example signature', () => {
        const h = sigv4({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' } }, { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }, { region: 'us-east-1', service: 'iam', now: new Date('2015-08-30T12:36:00Z') })
        assert.equal(h._signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
        assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d67/)
    })
    test('the Google JWT is RS256 over the claims; the OCI signature covers the body hash', () => {
        const [h, c, s] = googleJwt(SA, { now: 1_700_000_000_000 }).split('.')
        assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'k1' })
        assert.equal(JSON.parse(Buffer.from(c, 'base64url')).exp, 1_700_003_600)
        assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), google.publicKey, Buffer.from(s, 'base64url')))
        const o = ociSign({ method: 'PUT', url: 'https://x.example/20180222/nodePools/p?y=1', body: '{"a":1}' }, OCI, { now: new Date('2026-01-02T03:04:05Z') })
        assert.equal(o._signingString, 'date: Fri, 02 Jan 2026 03:04:05 GMT\n(request-target): put /20180222/nodePools/p?y=1\nhost: x.example\ncontent-length: 7\ncontent-type: application/json\nx-content-sha256: ' + crypto.createHash('sha256').update('{"a":1}').digest('base64'))
    })
    test('upgrade targets: at most one minor ahead', () => {
        assert.deepEqual(nextVersions('1.30.5-gke.1014001', ['1.32.0-gke.100', '1.31.1-gke.1678000', '1.30.6-gke.1125000', '1.30.5-gke.1014001', '1.29.9']), ['1.31.1-gke.1678000', '1.30.6-gke.1125000'])
        assert.deepEqual(nextVersions('1.30', ['1.32', '1.31', '1.30']), ['1.31'])
    })
})

describe('each provider against its API', () => {
    test('Amazon EKS: node groups, scale, upgrade (SigV4, also through an assumed role)', async () => {
        reset()
        const o = await CLOUD_APIS.eks.overview(A.eks)
        assert.equal(o.version, '1.30'); assert.deepEqual(o.upgrades, ['1.31'])
        const g = o.pools.find(p => p.id === 'general')
        assert.deepEqual([g.count, g.min, g.max, g.machine, g.version], [3, 1, 5, 'm6i.large', '1.30'])
        await CLOUD_APIS.eks.scale(A.eks, 'general', { count: 7 })
        assert.deepEqual(state.eks.groups.general, { ...state.eks.groups.general, desired: 7, min: 1, max: 7 }, 'max grows with the size')
        await CLOUD_APIS.eks.upgrade(A.eks, '1.31')
        assert.equal(state.eks.version, '1.31')
        await CLOUD_APIS.eks.upgradePool(A.eks, 'gpu', '1.31')
        assert.equal(state.eks.groups.gpu.version, '1.31')
        // through a role: STS AssumeRole, then the session credentials sign
        const role = { ...A.eks, creds: { ...AWS, roleArn: 'arn:aws:iam::123456789012:role/kubeez' } }
        assert.equal((await CLOUD_APIS.eks.test(role)).version, '1.31')
        assert.ok(calls.some(c => c.host.startsWith('sts.')))
        await assert.rejects(CLOUD_APIS.eks.test({ ...A.eks, creds: { ...AWS, secretAccessKey: 'wrong-secret-0123456789abcdef' } }), (e) => e.status === 403 && /signature/.test(e.message) && /permissions/.test(e.hint))
        await assert.rejects(CLOUD_APIS.eks.test({ ...A.eks, ref: { ...A.eks.ref, region: 'eu-west-1.evil.com/x' } }), /Region is not valid/)
    })

    test('Azure AKS: pools (autoscaler → min/max), control plane only, pool upgrade; no read-only fields sent back', async () => {
        reset()
        const o = await CLOUD_APIS.aks.overview(A.aks)
        assert.equal(o.version, '1.29.7'); assert.deepEqual(o.upgrades, ['1.30.4', '1.30.3'], 'preview left out')
        const burst = o.pools.find(p => p.id === 'burst')
        assert.deepEqual([burst.autoscale, burst.min, burst.max, burst.upgrades], [true, 1, 6, ['1.29.7']])
        await CLOUD_APIS.aks.scale(A.aks, 'system', { count: 5 })
        assert.equal(state.aks.pools.system.count, 5)
        await assert.rejects(CLOUD_APIS.aks.scale(A.aks, 'burst', { count: 4 }), /autoscaler/)
        await CLOUD_APIS.aks.scale(A.aks, 'burst', { min: 2, max: 9 })
        assert.deepEqual([state.aks.pools.burst.min, state.aks.pools.burst.max], [2, 9])
        await CLOUD_APIS.aks.upgrade(A.aks, '1.30.4')
        assert.equal(state.aks.version, '1.30.4')
        assert.ok(state.aks.lastPut.properties.agentPoolProfiles.every(p => p.orchestratorVersion !== '1.30.4'), 'the pools stay')
        assert.equal(state.aks.lastPut.location, 'westeurope')
        await CLOUD_APIS.aks.upgradePool(A.aks, 'burst', '1.29.7')
        assert.equal(state.aks.pools.burst.version, '1.29.7')
        await assert.rejects(CLOUD_APIS.aks.test({ ...A.aks, creds: { ...A.aks.creds, clientSecret: 'wrong-secret' } }), /Invalid client secret/)
    })

    test('Google GKE: the JWT goes to Google only (not the file\'s token_uri); per-zone sizes; upgrades', async () => {
        reset()
        const o = await CLOUD_APIS.gke.overview(A.gke)
        assert.ok(calls.some(c => c.host === 'oauth2.googleapis.com') && !calls.some(c => c.host === 'evil.example'))
        assert.deepEqual(o.upgrades, ['1.31.1-gke.1678000', '1.31.0-gke.1000', '1.30.6-gke.1125000'])
        const d = o.pools.find(p => p.id === 'default-pool')
        assert.deepEqual([d.count, d.perZone, d.machine], [2, 3, 'e2-standard-4'])
        await CLOUD_APIS.gke.scale(A.gke, 'default-pool', { count: 4 })
        assert.equal(state.gke.pools['default-pool'].size, 4)
        await CLOUD_APIS.gke.scale(A.gke, 'batch', { min: 1, max: 8 })
        assert.deepEqual(state.gke.pools.batch.auto, { min: 1, max: 8 })
        await CLOUD_APIS.gke.upgrade(A.gke, '1.31.1-gke.1678000')
        await CLOUD_APIS.gke.upgradePool(A.gke, 'batch', '1.31.1-gke.1678000')
        assert.deepEqual([state.gke.version, state.gke.pools.batch.version], ['1.31.1-gke.1678000', '1.31.1-gke.1678000'])
        await assert.rejects(CLOUD_APIS.gke.test({ ...A.gke, creds: { serviceAccountJson: '{"type":"user"}' } }), /service account key/)
    })

    test('Oracle OKE: request signature checked, pool size keeps its placement, upgrades cycle nodes', async () => {
        reset()
        const o = await CLOUD_APIS.oke.overview(A.oke)
        assert.deepEqual([o.version, o.upgrades, o.pools[0].count, o.pools[0].machine], ['v1.30.1', ['v1.31.1'], 3, 'VM.Standard.A1.Flex'])
        const pool = 'ocid1.nodepool.oc1.eu-frankfurt-1.aaaapool1'
        assert.equal((await CLOUD_APIS.oke.scale(A.oke, pool, { count: 4 })).operation, 'ocid1.workrequest.2')
        assert.equal(state.oke.pools[pool].size, 4)
        await CLOUD_APIS.oke.upgrade(A.oke, 'v1.31.1')
        await CLOUD_APIS.oke.upgradePool(A.oke, pool, 'v1.31.1')
        assert.deepEqual([state.oke.version, state.oke.pools[pool].version], ['v1.31.1', 'v1.31.1'])
        const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
        await assert.rejects(CLOUD_APIS.oke.test({ ...A.oke, creds: { ...OCI, privateKey: other } }), /NotAuthenticated|authentication/)
    })

    test('DigitalOcean DOKS and Linode LKE: bearer tokens; DOKS upgrades pools with the cluster, LKE recycles', async () => {
        reset()
        const d = await CLOUD_APIS.doks.overview(A.doks)
        assert.deepEqual([d.version, d.upgrades, d.pools[0].count], ['1.30.4-do.0', ['1.31.1-do.0'], 2])
        await CLOUD_APIS.doks.scale(A.doks, '11111111-2222-3333-4444-555555555555', { count: 3 })
        await CLOUD_APIS.doks.upgrade(A.doks, '1.31.1-do.0')
        assert.deepEqual([state.doks.pools['11111111-2222-3333-4444-555555555555'].count, state.doks.version], [3, '1.31.1-do.0'])
        assert.equal(CLOUD_APIS.doks.upgradePool, null)
        const l = await CLOUD_APIS.lke.overview(A.lke)
        assert.deepEqual([l.version, l.upgrades, l.pools[0].id, l.pools[0].count], ['1.30', ['1.31'], '77', 3])
        await CLOUD_APIS.lke.scale(A.lke, '77', { count: 5 })
        await CLOUD_APIS.lke.upgrade(A.lke, '1.31')
        await CLOUD_APIS.lke.upgradePool(A.lke, '77')
        assert.deepEqual([state.lke.pools[77].count, state.lke.version, state.lke.pools[77].recycled], [5, '1.31', true])
        await assert.rejects(CLOUD_APIS.lke.test({ ...A.lke, creds: { token: 'wrong-token-xx' } }), /Invalid Token/)
    })
})

describe('the cloud account of a connected cluster', () => {
    const eksCluster = { id: 'imp-eks', clusterName: 'shop-prod', orgId: 'org1', ownerId: 'u1', imported: true, provider: 'eks', distro: 'eks', k8sVersion: 'v1.30.4-eks-a737599', status: 'healthy', masterNodes: [], workerNodes: [], access: { mode: 'direct', level: 'read', server: 'https://x.eks.amazonaws.com', token: encrypt('eyA.eyB.c') } }
    const fresh = async () => (await clusterStore.getClusters()).find(c => c.id === 'imp-eks')

    test('connect: checked first, stored encrypted, never sent to the browser; audited', async () => {
        reset()
        await clusterStore.saveCluster(eksCluster)
        assert.equal(capabilities(eksCluster).cloudPools.ok, false)
        assert.match(capabilities(eksCluster).upgrade.why, /cloud account/)
        await assert.rejects(cloud.connectCloud(eksCluster, { ref: A.eks.ref, creds: { accessKeyId: AWS.accessKeyId } }, user), /Secret access key is required/)
        await assert.rejects(cloud.connectCloud(eksCluster, { ref: { ...A.eks.ref, clusterName: 'nope' }, creds: AWS }, user), (e) => e.status === 404)
        await cloud.connectCloud(eksCluster, { ref: A.eks.ref, creds: AWS }, user)
        const c = await fresh()
        assert.equal(c.cloud.provider, 'eks')
        assert.ok(!fs.readFileSync(`${DATA}/clusters.json`, 'utf8').includes(AWS.secretAccessKey), 'not in clear on disk')
        assert.ok(!JSON.stringify(stripCredentials(c)).includes(c.cloud.creds) && stripCredentials(c).cloud.hasCreds)
        const v = cloud.cloudView(c)
        assert.ok(v.connected && !JSON.stringify(v).includes(AWS.secretAccessKey) && /^key AKIAKUBE/.test(v.identity))
        assert.ok(v.setup.commands.some(x => /eks:UpdateNodegroupConfig/.test(x) && /cluster\/shop-prod/.test(x)), 'least-privilege policy for this cluster')
        assert.equal(capabilities(c).cloudPools.ok, true)
        assert.equal(capabilities(c).upgrade.ok, false, 'the kubeadm upgrade stays off')
        assert.ok(auditLog.query({ orgId: 'org1' }).some(e => e.action === 'cluster.cloud_connected'))
        // editing keeps the stored secret when the field is left blank
        await cloud.connectCloud(c, { ref: A.eks.ref, creds: { accessKeyId: AWS.accessKeyId } }, user)
    })

    test('a cloud cluster of another version is not this one', async () => {
        reset(); state.eks.version = '1.27'
        await assert.rejects(cloud.connectCloud({ ...eksCluster, cloud: null }, { ref: A.eks.ref, creds: AWS }, user), /same cluster/)
    })

    test('overview, scale (checked: size, busy, last nodes), upgrade only to an offered version, all audited', async () => {
        reset()
        const c = await fresh()
        const o = await cloud.cloudOverview(c)
        assert.deepEqual(o.upgrades, ['1.31'])
        assert.deepEqual([o.pools.find(p => p.id === 'gpu').upgradeTo, o.pools.find(p => p.id === 'general').upgradeTo], ['1.30', null], 'a pool behind the control plane follows it')
        assert.equal(o.pools[0].live, null, 'no live count without a reachable cluster API')
        await assert.rejects(cloud.scalePool(c, 'general', { count: -1 }, user), /whole number/)
        await assert.rejects(cloud.scalePool(c, 'general', { min: 5, max: 2 }, user), /Min is more than max/)
        await assert.rejects(cloud.scalePool(c, 'ghost', { count: 2 }, user), (e) => e.status === 404)
        state.eks.groups.general.status = 'UPDATING'
        await assert.rejects(cloud.scalePool(c, 'general', { count: 2 }, user), (e) => e.status === 409 && /busy/.test(e.message))
        state.eks.groups.general.status = 'ACTIVE'
        await assert.rejects(cloud.scalePool(c, 'general', { count: 0 }, user), /without nodes/)
        assert.deepEqual((await cloud.scalePool(c, 'general', { count: 4 }, user)).pool, 'general')
        assert.equal(state.eks.groups.general.desired, 4)
        await assert.rejects(cloud.upgradeCluster(c, '1.32', user), /not an upgrade the provider offers/)
        assert.deepEqual(await cloud.upgradeCluster(c, '1.31', user), { ok: true, from: '1.30', to: '1.31', operation: 'upd-1' })
        await assert.rejects(cloud.upgradePool(c, 'general', null, user), /busy|already/)
        state.eks.status = 'ACTIVE'
        assert.equal((await cloud.upgradePool(c, 'gpu', null, user)).to, '1.31')
        const log = auditLog.query({ orgId: 'org1' }).map(e => `${e.action} ${e.detail}`)
        assert.ok(log.some(l => /cluster.pool_scaled .*general: 3 → 4 nodes/.test(l)))
        assert.ok(log.some(l => /cluster.cloud_upgrade .*1.30 → 1.31/.test(l)))
        assert.ok(log.some(l => /cluster.pool_upgrade .*gpu: 1.29 → 1.31/.test(l)))
        // a failing call is remembered for the page
        await clusterStore.saveCluster({ ...(await fresh()), cloud: { ...(await fresh()).cloud, ref: { ...A.eks.ref, clusterName: 'gone' } } })
        await assert.rejects(cloud.cloudOverview(await fresh()))
        assert.match((await fresh()).cloud.lastError, /Amazon EKS/)
        await cloud.disconnectCloud(await fresh(), user)
        assert.equal((await fresh()).cloud, null)
        await assert.rejects(cloud.cloudOverview(await fresh()), (e) => e.code === 'NO_CLOUD_ACCOUNT')
    })

    test('providers without an API here say so; upgrades need the two-person approval when it is on', () => {
        assert.throws(() => cloud.apiFor({ provider: 'civo' }), /managed in its own console/)
        assert.equal(cloud.cloudView({ provider: 'k3s' }).supported, false)
        assert.equal(capabilities({ imported: true, provider: 'civo', access: { mode: 'direct', level: 'full' }, masterNodes: [] }).cloudPools, undefined)
        const r = PROTECTED_ACTIONS['cluster:upgrade'].route('imp-eks')
        assert.ok(r.test('POST /api/connect/clusters/imp-eks/cloud/upgrade'))
        assert.ok(r.test('POST /api/connect/clusters/imp-eks/cloud/pools/gpu/upgrade'))
        assert.ok(r.test('POST /api/clusters/imp-eks/upgrade'))
        assert.ok(!r.test('POST /api/connect/clusters/imp-eks/cloud/pools/gpu/scale'))
    })
})
