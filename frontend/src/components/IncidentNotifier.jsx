import { useEffect, useRef } from 'react'
import { useToast } from './ToastProvider'
import { useAuth, apiFetch } from '../context/AuthContext'

// Human-friendly titles for incident reasons
const REASON_LABEL = {
    NodeNotReady:      'Node Down',
    DiskPressure:      'Disk Pressure',
    MemoryPressure:    'Memory Pressure',
    PIDPressure:       'Process Pressure',
    CrashLoopBackOff:  'Pod Crash Loop',
    OOMKilled:         'Out of Memory',
    ImagePullBackOff:  'Image Pull Failed',
    PodPendingTooLong: 'Pod Stuck Pending'
}

const POLL_MS = 8000

/**
 * App-wide watcher that turns incident lifecycle changes into toast alerts, so
 * the user always knows the moment a node/pod goes down and when it's healed —
 * without needing to sit on the Incidents page.
 */
export default function IncidentNotifier() {
    const { toast } = useToast()
    const { isAuthenticated } = useAuth()
    const seen = useRef(new Map())   // id -> last status
    const primed = useRef(false)     // skip toasts on the very first load

    useEffect(() => {
        if (!isAuthenticated) return
        let cancelled = false

        const tick = async () => {
            try {
                const res = await apiFetch('/api/incidents')
                if (!res.ok) return
                const incidents = await res.json()
                if (cancelled || !Array.isArray(incidents)) return

                // Collect changes this cycle, then notify in a grouped way so a
                // node-down (which spawns many incidents) doesn't flood the screen.
                const created = []
                const resolved = []
                const failed = []
                const manual = []

                for (const inc of incidents) {
                    const prev = seen.current.get(inc.id)
                    if (!primed.current) { seen.current.set(inc.id, inc.status); continue }

                    if (prev === undefined) {
                        created.push(inc)
                    } else if (prev !== inc.status) {
                        if (inc.status === 'resolved') resolved.push(inc)
                        else if (inc.status === 'failed') failed.push(inc)
                        else if (inc.status === 'unresolved') manual.push(inc)
                    }
                    seen.current.set(inc.id, inc.status)
                }

                const label = (inc) => REASON_LABEL[inc.reason] || inc.reason
                const where = (inc) => inc.target && inc.target !== 'cluster-wide' ? ` (${inc.target})` : ''

                // NEW incidents
                if (created.length === 1) {
                    const inc = created[0]
                    toast({ title: `⚠️ ${label(inc)}`, message: `${inc.clusterName}${where(inc)}: ${inc.message || 'issue detected'} — auto-healing started`, type: 'error', duration: 8000 })
                } else if (created.length > 1) {
                    const cl = created[0].clusterName
                    toast({ title: `⚠️ ${created.length} issues detected`, message: `${cl}: auto-healing started on ${created.length} problems. Open Incidents for details.`, type: 'error', duration: 8000 })
                }

                // RESOLVED
                if (resolved.length === 1) {
                    const inc = resolved[0]
                    toast({ title: `✅ Resolved: ${label(inc)}`, message: `${inc.clusterName}${where(inc)} is healthy again`, type: 'success', duration: 7000 })
                } else if (resolved.length > 1) {
                    toast({ title: `✅ ${resolved.length} issues resolved`, message: `${resolved[0].clusterName}: auto-healing restored ${resolved.length} items to healthy.`, type: 'success', duration: 7000 })
                }

                // FAILED (needs attention)
                if (failed.length === 1) {
                    const inc = failed[0]
                    toast({ title: `❌ Auto-heal failed: ${label(inc)}`, message: `${inc.clusterName}${where(inc)} needs manual attention${inc.details ? ' — ' + inc.details : ''}`, type: 'error', duration: 12000 })
                } else if (failed.length > 1) {
                    toast({ title: `❌ ${failed.length} auto-heals failed`, message: `${failed[0].clusterName}: ${failed.length} issues need manual attention. Open Incidents.`, type: 'error', duration: 12000 })
                }

                // MANUAL (no auto-fix)
                if (manual.length === 1) {
                    const inc = manual[0]
                    toast({ title: `🔧 Action required: ${label(inc)}`, message: `${inc.clusterName}${where(inc)}: ${inc.details || inc.message || 'manual fix needed'}`, type: 'info', duration: 10000 })
                } else if (manual.length > 1) {
                    toast({ title: `🔧 ${manual.length} items need action`, message: `${manual[0].clusterName}: ${manual.length} issues require manual review. Open Incidents.`, type: 'info', duration: 10000 })
                }

                primed.current = true
            } catch (_) { /* ignore transient errors */ }
        }

        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { cancelled = true; clearInterval(timer) }
    }, [isAuthenticated])

    return null // headless — only fires toasts
}
