// Self-hosted licenses give every workspace their plan: features (also the
// background ones), paid-plan checks and team seats follow an active license;
// expired, wrongly signed or other-server licenses, and the hosted edition, do not.
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret-test-secret-test-secret-123'
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'

const vendor = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const stranger = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
fs.writeFileSync(path.join(DATA, 'public.pem'), vendor.publicKey.export({ type: 'spki', format: 'pem' }))
fs.writeFileSync(path.join(DATA, 'system.json'), JSON.stringify({ systemId: 'SYS-THIS-1' }))

const { licensedPlan, forgetLicensePlan, planOfLicense } = await import('../src/services/licensePlan.js')
const { authService } = await import('../src/services/authService.js')
const { features } = await import('../src/services/features.js')
const { isPaidPlan } = await import('../src/config/planFeatures.js')
after(() => { process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

const sign = (claims, { key = vendor.privateKey, days = 30 } = {}) => jwt.sign({ maxClusters: 10, maxNodes: 50, ...claims }, key, { algorithm: 'RS256', expiresIn: `${days}d` })
const activate = (token) => { fs.writeFileSync(path.join(DATA, 'license.json'), JSON.stringify({ licenseKey: token })); forgetLicensePlan() }
const noLicense = () => { fs.rmSync(path.join(DATA, 'license.json'), { force: true }); forgetLicensePlan() }
beforeEach(noLicense)

// the first self-hosted user: superadmin on the FREE plan; then a workspace admin of the same workspace
await authService.registerUser('owner1', 'Owner-pass-123!', 'owner@example.com', { setup: true })
const owner = authService.users.find(u => u.username === 'owner1')
const orgId = owner.orgId

test('plan names: ENTERPRISE stays enterprise, every other paid license is PRO', () => {
    assert.equal(planOfLicense('ENTERPRISE'), 'ENTERPRISE')
    assert.equal(planOfLicense('enterprise-annual'), 'ENTERPRISE')
    for (const n of ['PRO', 'EVALUATION', 'TRIAL', 'UNLIMITED']) assert.equal(planOfLicense(n), 'PRO')
})

test('no license: the owner\'s FREE plan; Pro features (and their background work) are off for the workspace', () => {
    assert.equal(owner.role, 'superadmin'); assert.equal(owner.subscription.plan, 'FREE')
    assert.equal(licensedPlan(), null)
    assert.equal(authService.getOrgPlan(orgId), 'FREE')
    assert.equal(features.usable(orgId, 'previews'), false)
    assert.equal(features.planOk(orgId, 'previews', 'admin'), false, 'another admin of the workspace')
    assert.equal(authService.seatLimit(orgId), 1)
})

test('an active license gives every workspace its plan: features, paid checks, background work; seats', () => {
    activate(sign({ plan: 'PRO' }))
    assert.equal(licensedPlan().plan, 'PRO')
    assert.equal(authService.getOrgPlan(orgId), 'PRO')
    assert.equal(isPaidPlan(authService.getOrgPlan(orgId)), true)
    assert.equal(features.usable(orgId, 'previews'), true)
    assert.equal(features.planOk(orgId, 'previews', 'admin'), true)
    assert.equal(authService.seatLimit(orgId), null, 'no seat count = no limit')
    activate(sign({ plan: 'ENTERPRISE', maxMembers: 3 }))
    assert.equal(authService.getOrgPlan(orgId), 'ENTERPRISE'); assert.equal(authService.seatLimit(orgId), 3)
})

test('seats from the license are enforced when adding members', async () => {
    activate(sign({ plan: 'PRO', maxMembers: 2 }))
    await authService.createTeamMember(orgId, 'member1', 'Member-pass-123!', 'm1@example.com', 'viewer')
    await assert.rejects(authService.createTeamMember(orgId, 'member2', 'Member-pass-123!', 'm2@example.com', 'viewer'), /seat limit reached \(2\)/)
    activate(sign({ plan: 'PRO' }))
    await authService.createTeamMember(orgId, 'member2', 'Member-pass-123!', 'm2@example.com', 'viewer')
})

test('expired, signed by someone else, bound to another server → no plan; bound to this one → plan', () => {
    activate(sign({ plan: 'PRO' }, { days: -1 }))
    assert.equal(authService.getOrgPlan(orgId), 'FREE', 'expired')
    activate(sign({ plan: 'PRO' }, { key: stranger.privateKey }))
    assert.equal(authService.getOrgPlan(orgId), 'FREE', 'not the vendor\'s signature')
    activate(sign({ plan: 'PRO', systemId: 'SYS-OTHER-9' }))
    assert.equal(authService.getOrgPlan(orgId), 'FREE', 'another server\'s license')
    activate(sign({ plan: 'PRO', systemId: 'SYS-THIS-1' }))
    assert.equal(authService.getOrgPlan(orgId), 'PRO')
    activate('not-a-jwt')
    assert.equal(authService.getOrgPlan(orgId), 'FREE')
})

test('a workspace on its own higher plan keeps it; the hosted edition ignores licenses', () => {
    activate(sign({ plan: 'PRO' }))
    const prev = owner.subscription
    owner.subscription = { ...prev, plan: 'ENTERPRISE' }
    try { assert.equal(authService.getOrgPlan(orgId), 'ENTERPRISE') } finally { owner.subscription = prev }
    process.env.KUBEEZ_MODE = 'saas'
    try { forgetLicensePlan(); assert.equal(licensedPlan(), null); assert.equal(authService.getOrgPlan(orgId), 'FREE') } finally { process.env.KUBEEZ_MODE = 'selfhosted'; forgetLicensePlan() }
})
