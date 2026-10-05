import { useState, useRef, useEffect, useCallback } from 'react'
import { apiFetch } from '../../context/AuthContext'

/**
 * Follow a background etcd job (backup / fetch / restore / recover).
 * The backend runs them as jobs because a restore takes longer than a proxied
 * HTTP request may stay open — the UI polls the job every 2 s.
 */
export function useEtcdJob(clusterId, onDone) {
    const [job, setJob] = useState(null)
    const timer = useRef(null)
    const doneRef = useRef(onDone)
    doneRef.current = onDone

    const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
    useEffect(() => stop, [])

    const watch = useCallback((jobId) => {
        stop()
        const tick = async () => {
            try {
                const r = await apiFetch(`/api/clusters/${clusterId}/etcd/jobs/${jobId}`)
                const j = await r.json().catch(() => null)
                if (!r.ok || !j) {
                    setJob(prev => ({ ...(prev || {}), id: jobId, status: 'failed', error: j?.error || 'Lost track of the job' }))
                    return
                }
                setJob(j)
                if (j.status === 'running') timer.current = setTimeout(tick, 2000)
                else doneRef.current?.(j)
            } catch {
                timer.current = setTimeout(tick, 4000)   // network blip — keep following
            }
        }
        tick()
    }, [clusterId])

    const clear = () => { stop(); setJob(null) }
    return { job, watch, clear }
}

/** POST that starts a job → { jobId } or throws with the server's message. */
export async function startJob(path, body) {
    const r = await apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.jobId) {
        const e = new Error(j.error || `Request failed (${r.status})`)
        e.jobId = j.jobId
        throw e
    }
    return j.jobId
}
