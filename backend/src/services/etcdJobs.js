import { randomUUID } from 'crypto'

const KEEP_MS = 2 * 60 * 60 * 1000   // finished jobs stay readable for 2 hours
const MAX_LOG = 2000

/**
 * Background jobs for etcd backup / restore / recovery.
 *
 * A restore takes minutes — far longer than a proxied HTTP request may stay
 * open (nginx: 120 s) — so the route starts a job and the UI polls it. One job
 * per cluster at a time: two restores (or a backup during a restore) on the
 * same control-plane would fight over etcd.
 */
class EtcdJobs {
    constructor() {
        this.jobs = new Map()
        this.byCluster = new Map()   // clusterId → running job id
    }

    activeFor(clusterId) {
        const id = this.byCluster.get(clusterId)
        return id ? this.jobs.get(id) : null
    }

    get(id) { return this.jobs.get(id) || null }

    /** Public view (no internals). */
    view(job) {
        if (!job) return null
        const { id, clusterId, kind, status, step, progress, logs, result, error, startedAt, finishedAt, meta } = job
        return { id, clusterId, kind, status, step, progress, logs, result, error, startedAt, finishedAt, meta }
    }

    /**
     * Start `fn({ log, progress })` in the background. Throws (status 409) when
     * the cluster already has a running job.
     */
    start(clusterId, kind, fn, meta = {}) {
        const busy = this.activeFor(clusterId)
        if (busy) {
            throw Object.assign(new Error(`Another etcd operation (${busy.kind}) is still running on this cluster — wait until it finishes.`), { status: 409, jobId: busy.id })
        }
        this._gc()
        const job = {
            id: randomUUID(), clusterId, kind, meta,
            status: 'running', step: null, progress: 0, logs: [],
            result: null, error: null,
            startedAt: new Date().toISOString(), finishedAt: null
        }
        this.jobs.set(job.id, job)
        this.byCluster.set(clusterId, job.id)

        const log = (level, msg) => {
            if (job.logs.length >= MAX_LOG) job.logs.shift()
            job.logs.push({ level, msg: String(msg), at: Date.now() })
        }
        const progress = (pct, step) => {
            if (typeof pct === 'number') job.progress = Math.max(job.progress, Math.min(100, pct))
            if (step) job.step = step
        }

        Promise.resolve()
            .then(() => fn({ log, progress }))
            .then(result => {
                job.status = 'succeeded'; job.result = result ?? null; job.progress = 100
            })
            .catch(err => {
                job.status = 'failed'; job.error = err?.message || String(err)
                if (err?.result) job.result = err.result
            })
            .finally(() => {
                job.finishedAt = new Date().toISOString()
                if (this.byCluster.get(clusterId) === job.id) this.byCluster.delete(clusterId)
            })
        return job
    }

    _gc() {
        const now = Date.now()
        for (const [id, j] of this.jobs) {
            if (j.status !== 'running' && now - new Date(j.finishedAt).getTime() > KEEP_MS) this.jobs.delete(id)
        }
    }
}

export const etcdJobs = new EtcdJobs()
