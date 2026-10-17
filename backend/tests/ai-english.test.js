// Every KubeEZ AI answer is in English, whatever language the question is in:
// the model is told so and reads the question in English; an answer in Hindi /
// Hinglish, or one that only repeats the question, is asked again once and is
// otherwise never shown. Code (YAML) is not checked. Fake model server.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { tempDataDir } from './helpers/server.js'

const DATA = tempDataDir()
process.env.KUBEEZ_DATA_DIR = DATA
process.env.APP_SECRET ||= 'test-secret'
delete process.env.KUBEEZ_AI_URL
const prevMode = process.env.KUBEEZ_MODE
process.env.KUBEEZ_MODE = 'selfhosted'

const { ask, notEnglish, nonEnglishQuestion, roughEnglish } = await import('../src/services/ai/engine.js')
const { aiStore } = await import('../src/services/ai/aiStore.js')

let replies = [], seen = []
let fake, base
before(async () => {
    fake = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c)
        req.on('end', () => {
            seen.push(JSON.parse(b || '{}'))
            const content = replies.length > 1 ? replies.shift() : replies[0]
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        })
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${fake.address().port}`
})
after(() => { fake.closeAllConnections?.(); fake.close(); process.env.KUBEEZ_MODE = prevMode; fs.rmSync(DATA, { recursive: true, force: true }) })

describe('what counts as English', () => {
    test('Hindi script, Hinglish and a repeated question are not', () => {
        assert.match(notEnglish('क्या service और ingress में फर्क है?'), /Hindi script/)
        assert.match(notEnglish('Pod crashloop me kyu jata hai, kaise theek kare?'), /Hinglish/)
        assert.match(notEnglish('Pod "mera" pending hai.'), /Hinglish/)
        assert.match(notEnglish('The image pull error "kuya aata hai" means the image is missing.'), /Hinglish/)
        assert.match(notEnglish('pod crashloop in why is, how fix??', 'pod crashloop me kyu jata hai, kaise theek kare?'), /repeats the question/)
        assert.match(notEnglish('The same question in English: what is a pod?', 'pod kya hai'), /repeats the question/)
    })
    test('proper English is, also with commands, names and a quoted log line', () => {
        assert.equal(notEnglish('A DaemonSet runs one pod on every node, for example a log collector.'), null)
        assert.equal(notEnglish('Restart it: `kubectl rollout restart deploy/web -n shop`. The log says "connection refused".', 'web theek karo'), null)
        assert.equal(notEnglish('The PVC is pending because no StorageClass can provide a volume. Install a storage add-on.', 'pvc pending kyu hai'), null)
    })
    test('which questions are not in English, and their English', () => {
        assert.equal(nonEnglishQuestion('what is a pod'), false)
        assert.equal(nonEnglishQuestion('pod kya hai'), true)
        assert.equal(nonEnglishQuestion('क्या बदला'), true)
        assert.equal(roughEnglish('daemonset kya hota hai?'), 'daemonset what is?')
        assert.equal(roughEnglish('mera pod pending me atka hai kya karu'), 'my pod pending in stuck is what should I do')
        assert.equal(/[ऀ-ॿ]/.test(roughEnglish('क्या service और ingress में फर्क है?')), false)
    })
})

describe('the engine: English answers only', () => {
    const org = 'org-en'
    const user = { id: 'u', username: 'u', orgId: org, role: 'admin' }
    before(() => aiStore.addProvider(org, { name: 'Fake', kind: 'ollama', baseUrl: base, model: 'm' }))

    test('the model is told to answer in English, and reads a Hinglish question in English', async () => {
        replies = ['A DaemonSet runs one pod on every node.']; seen = []
        const r = await ask(user, { task: 'chat', question: 'daemonset kya hota hai?' })
        assert.equal(r.text, 'A DaemonSet runs one pod on every node.')
        const sys = seen[0].messages.find(m => m.role === 'system').content
        assert.match(sys, /Always answer in clear, correct, professional English/)
        const user1 = seen[0].messages.filter(m => m.role === 'user').pop().content
        assert.match(user1, /daemonset what is\?$/, 'the question it reads last is in English')
        assert.match(user1, /as the user wrote it/, 'the original words are there for meaning, as data')
    })

    test('a Hinglish answer is asked again — fresh, with only the English question', async () => {
        replies = ['DaemonSet har node pe ek pod chalata hai.', 'A DaemonSet runs one pod on every node.']; seen = []
        const r = await ask(user, { task: 'chat', question: 'daemonset kya hota hai?' })
        assert.equal(r.text, 'A DaemonSet runs one pod on every node.')
        assert.equal(seen.length, 2)
        const retry = seen[1].messages.filter(m => m.role !== 'system')
        assert.equal(retry.length, 1, 'a fresh ask, not a conversation with the bad answer')
        assert.equal(/chalata|kya hota/.test(retry[0].content), false, 'neither the bad answer nor the Hinglish question')
        assert.match(retry[0].content, /Answer only in clear, correct English/)
        assert.ok(r.attempts.some(a => /answer rejected: it is in Hinglish/.test(a.error || '')))
    })

    test('never English → not shown at all (the caller gets "no answer", never Hinglish)', async () => {
        replies = ['क्या service और ingress में फर्क है?']; seen = []
        await assert.rejects(() => ask(user, { task: 'chat', question: 'क्या service और ingress में फर्क है?' }), (e) => e.code === 'AI_UNAVAILABLE' && e.attempts.filter(a => /Hindi script/.test(a.error || '')).length === 2)
    })

    test('JSON answers: their sentences are checked (not the quoted evidence)', async () => {
        replies = [JSON.stringify({ summary: 'Pod crash ho raha hai kyunki database nahi mil raha.', cause: 'db', fix: ['x'], evidence: [] }), JSON.stringify({ summary: 'The pod crashes because it cannot reach its database.', cause: 'The database is down.', fix: ['Start the database'], evidence: ['ERROR: kya hai yeh'] })]
        const r = await ask(user, { task: 'explain', json: true, question: 'web kyu crash ho raha hai' })
        assert.equal(r.json.summary, 'The pod crashes because it cannot reach its database.')
    })

    test('code is not checked: YAML may hold any names', async () => {
        replies = ['apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: mera-app-config\ndata:\n  greeting: "namaste, kya haal hai"']; seen = []
        const r = await ask(user, { task: 'chat', english: false, question: 'mera app ka configmap banao' })
        assert.match(r.text, /mera-app-config/)
        assert.equal(seen.length, 1)
    })

    test('English questions are passed as they are', async () => {
        replies = ['A StatefulSet keeps stable names and storage for each pod.']; seen = []
        await ask(user, { task: 'chat', question: 'what is a statefulset?' })
        assert.equal(seen[0].messages.filter(m => m.role === 'user').pop().content.endsWith('what is a statefulset?'), true)
    })
})
