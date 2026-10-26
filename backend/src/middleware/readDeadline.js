// A page that reads from a cluster (add-on status, nodes…) must answer before
// Cloudflare gives up (100 s) — or the screen gets its HTML page instead of a
// reason. Reads still waiting at the deadline get one; whatever the handler
// sends later is dropped. Live streams (events, logs) are not cut.
export function readDeadline(ms = Number(process.env.KUBEEZ_READ_DEADLINE_MS) || 90000) {
    return (req, res, next) => {
        if (req.method !== 'GET' || /text\/event-stream/.test(req.headers.accept || '')) return next()
        const timer = setTimeout(() => {
            if (res.headersSent || res.writableEnded) return
            res.status(503).json({ error: `The cluster did not answer within ${Math.round(ms / 1000)} seconds. Its servers may be off or unreachable from KubeEZ (or through the Gateway Agent). Check that they are running, then try again.`, code: 'CLUSTER_TIMEOUT' })
            for (const k of ['status', 'set', 'setHeader', 'json', 'send', 'end', 'write', 'writeHead']) res[k] = function () { return res }
        }, ms)
        timer.unref?.()
        res.on('close', () => clearTimeout(timer))
        res.on('finish', () => clearTimeout(timer))
        next()
    }
}
