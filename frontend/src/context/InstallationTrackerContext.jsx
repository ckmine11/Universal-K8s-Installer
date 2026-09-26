import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { apiFetch, useAuth } from './AuthContext'

const InstallationTrackerContext = createContext()
const STORAGE_KEY = 'kubeez_active_installations'
const DISMISSED_KEY = 'kubeez_dismissed_installations'
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // drop entries older than 24h

export function useInstallationTracker() {
    return useContext(InstallationTrackerContext)
}

// Load persisted installations from localStorage (survives page refresh)
function loadPersisted() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        const now = Date.now()
        return Array.isArray(parsed)
            ? parsed.filter(i => now - new Date(i.startedAt || 0).getTime() < MAX_AGE_MS)
            : []
    } catch {
        return []
    }
}

function loadDismissed() {
    try {
        const raw = localStorage.getItem(DISMISSED_KEY)
        const parsed = raw ? JSON.parse(raw) : []
        return new Set(Array.isArray(parsed) ? parsed : [])
    } catch {
        return new Set()
    }
}

/**
 * Tracks active installations globally so the user can navigate back from
 * any page — even after a full browser refresh. State is persisted to
 * localStorage AND continuously reconciled with the backend, so a running
 * install is never "lost".
 */
export function InstallationTrackerProvider({ children }) {
    const { isAuthenticated } = useAuth()
    const [activeInstallations, setActiveInstallations] = useState(loadPersisted)
    const dismissedRef = useRef(loadDismissed())
    const pollRef = useRef(null)

    // Persist to localStorage whenever the list changes
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(activeInstallations))
        } catch { /* quota — ignore */ }
    }, [activeInstallations])

    const trackInstallation = useCallback((installation) => {
        setActiveInstallations(prev => {
            const exists = prev.find(i => i.id === installation.id)
            if (exists) {
                return prev.map(i => i.id === installation.id ? { ...i, ...installation } : i)
            }
            return [...prev, installation]
        })
    }, [])

    const updateInstallation = useCallback((id, updates) => {
        setActiveInstallations(prev => {
            const exists = prev.find(i => i.id === id)
            // If we get an update for something we aren't tracking yet, add it
            if (!exists) return [...prev, { id, ...updates }]
            return prev.map(i => i.id === id ? { ...i, ...updates } : i)
        })
    }, [])

    const removeInstallation = useCallback((id) => {
        // Record dismissal so the backend poll doesn't re-add it
        dismissedRef.current.add(id)
        try {
            localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedRef.current].slice(-200)))
        } catch { /* ignore */ }
        setActiveInstallations(prev => prev.filter(i => i.id !== id))
    }, [])

    const getRunningInstallations = useCallback(() => {
        return activeInstallations.filter(i => i.status === 'running')
    }, [activeInstallations])

    // ── Reconcile with backend: hydrate on load + poll while anything runs ──
    // Only runs when authenticated — avoids pre-login 401s that would trigger
    // an unwanted logout/redirect.
    useEffect(() => {
        if (!isAuthenticated) return
        let cancelled = false

        const syncFromBackend = async () => {
            try {
                const res = await apiFetch('/api/clusters/installations/active')
                if (!res.ok) return
                const serverList = await res.json()
                if (cancelled || !Array.isArray(serverList)) return

                setActiveInstallations(prev => {
                    const byId = new Map(prev.map(i => [i.id, i]))
                    for (const s of serverList) {
                        // Skip anything the user has explicitly dismissed
                        if (dismissedRef.current.has(s.id)) continue
                        byId.set(s.id, { ...byId.get(s.id), ...s })
                    }
                    return Array.from(byId.values())
                })
            } catch { /* offline / auth — ignore, keep local state */ }
        }

        // Initial hydrate
        syncFromBackend()

        // Poll every 4s so progress stays fresh even when not on the dashboard
        pollRef.current = setInterval(syncFromBackend, 4000)
        return () => { cancelled = true; clearInterval(pollRef.current) }
    }, [isAuthenticated])

    return (
        <InstallationTrackerContext.Provider value={{
            activeInstallations,
            trackInstallation,
            updateInstallation,
            removeInstallation,
            getRunningInstallations
        }}>
            {children}
        </InstallationTrackerContext.Provider>
    )
}
