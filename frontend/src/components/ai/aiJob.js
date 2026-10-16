import { apiFetch } from '../../context/AuthContext'

// Ask KubeEZ AI something that may take a while (a CPU model, a slow cluster):
// the server answers within ~20 s, or gives a job id that is polled until the
// answer is there — so no proxy timeout ever cuts it off.
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export async function aiJob(url, body, { maxMs = 8 * 60e3 } = {}) {
    let res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    let data = await res.json().catch(() => ({}))
    const jobId = data.jobId
    const end = Date.now() + maxMs
    while (res.status === 202 && jobId && Date.now() < end) {
        await sleep(2500)
        try {
            res = await apiFetch(`/api/ai/jobs/${jobId}`)
            data = await res.json().catch(() => ({}))
        } catch { /* a network blip — keep polling */ }
    }
    if (res.status === 202) return { ok: false, data: { error: 'KubeEZ AI is still working on it — try again in a few minutes.' } }
    if (!res.ok && !data.error) data.error = `KubeEZ AI could not answer (HTTP ${res.status})`
    return { ok: res.ok, status: res.status, data }
}
