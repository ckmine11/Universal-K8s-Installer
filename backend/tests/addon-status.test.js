// The add-on status script: namespaces listed once, and only add-ons whose
// namespace exists looked at — run in bash with a fake kubectl that logs calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { statusScript } from '../src/services/addonManager.js'

const REGISTRY = {
    ingress: { ns: 'ingress-nginx', detect: 'deploy/ingress', probe: 'deploy/ingress' },
    monitoring: { ns: 'monitoring', detect: 'deploy/grafana' },
    vault: { ns: 'vault', detect: 'statefulset/vault' },
}
// kb: a fake kubectl; NSLIST: what "get ns" prints (empty = cannot list)
const run = (nslist) => {
    const fake = `kb() { echo "$*" >> "$CALLS"; case "$*" in
        "get ns -o jsonpath="*) printf '%s' "$NSLIST" ;;
        "get ns ingress-nginx -o jsonpath="*) echo Active ;;
        *"get deploy/ingress -o name") echo deployment.apps/ingress ;;
        *"get deploy/ingress -o jsonpath="*) echo registry.k8s.io/ingress-nginx/controller:v1.12.1 ;;
        *"get pods -o json") echo '{"items":[]}' ;;
    esac; }`
    const calls = `${process.env.TMPDIR || process.env.TEMP || '/tmp'}/kz-addon-calls-${process.pid}-${Date.now()}`
    const out = execFileSync('bash', ['-c', `${fake}\n${statusScript('kb', REGISTRY)}\ncat "$CALLS"; rm -f "$CALLS"`], { env: { ...process.env, CALLS: calls, NSLIST: nslist }, encoding: 'utf8' })
    return out
}

test('one namespace list, then only installed add-ons are looked at; same output as before', () => {
    const out = run('default=Active\ningress-nginx=Active\nkube-system=Active\n')
    const blocks = out.split('@@ADDON ').slice(1)
    const ingress = blocks.find(b => b.startsWith('ingress'))
    assert.match(ingress, /@@NS Active/); assert.match(ingress, /@@DETECT deployment.apps\/ingress/); assert.match(ingress, /@@IMAGE registry.k8s.io\/ingress-nginx\/controller:v1.12.1/); assert.match(ingress, /\{"items":\[\]\}/)
    const vault = blocks.find(b => b.startsWith('vault'))
    assert.match(vault, /@@NS \n/); assert.doesNotMatch(vault, /@@DETECT/)
    const calls = out.split('\n').filter(l => /^(get|-n) /.test(l))
    assert.equal(calls.filter(c => c.startsWith('get ns')).length, 1, 'namespaces listed once')
    assert.equal(calls.filter(c => c.includes('-n monitoring') || c.includes('-n vault')).length, 0, 'add-ons that are not there cost nothing')
    assert.equal(calls.length, 4, 'ns list + detect + image + pods of the one installed add-on')
})

test('if the namespaces cannot be listed, every add-on is checked one by one (as before)', () => {
    const out = run('')
    const calls = out.split('\n').filter(l => /^(get|-n) /.test(l))
    assert.equal(calls.filter(c => /^get ns \S+ -o jsonpath/.test(c)).length, 3, 'each namespace asked')
    assert.match(out.split('@@ADDON ').find(b => b.startsWith('ingress')), /@@DETECT deployment.apps\/ingress/)
})
