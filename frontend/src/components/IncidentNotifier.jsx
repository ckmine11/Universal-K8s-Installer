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

                for (const inc of incidents) {
                    const prev = seen.current.get(inc.id)
                    const label = REASON_LABEL[inc.reason] || inc.reason
                    const where = inc.target && inc.target !== 'cluster-wide' ? ` (${inc.target})` : ''

                    // First poll: just record current state, don't spam old incidents
                    if (!primed.current) { seen.current.set(inc.id, inc.status); continue }

                    if (prev === undefined) {
                        // Brand-new incident detected
                        toast({
                            title: `⚠️ ${label}`,
                            message: `${inc.clusterName}${where}: ${inc.message || 'issue detected'} — auto-healing started`,
                            type: 'error',
                            duration: 8000
                        })
                    } else if (prev !== inc.status) {
                        // Status transition
                        if (inc.status === 'resolved') {
                            toast({
                                title: `✅ Resolved: ${label}`,
                                message: `${inc.clusterName}${where} is healthy again${inc.details ? ' — ' + inc.details : ''}`,
                                type: 'success',
                                duration: 7000
                            })
                        } else if (inc.status === 'failed') {
                            toast({
                                title: `❌ Auto-heal failed: ${label}`,
                                message: `${inc.clusterName}${where} needs manual attention${inc.details ? ' — ' + inc.details : ''}`,
                                type: 'error',
                                duration: 12000
                            })
                        } else if (inc.status === 'unresolved') {
                            toast({
                                title: `🔧 Action required: ${label}`,
                                message: `${inc.clusterName}${where}: ${inc.details || inc.message || 'manual fix needed'}`,
                                type: 'info',
                                duration: 10000
                            })
                        }
                    }
                    seen.current.set(inc.id, inc.status)
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
