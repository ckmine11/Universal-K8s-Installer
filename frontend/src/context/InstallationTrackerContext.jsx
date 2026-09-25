import { createContext, useContext, useState, useCallback } from 'react'

const InstallationTrackerContext = createContext()

export function useInstallationTracker() {
    return useContext(InstallationTrackerContext)
}

/**
 * Tracks active (running) installations globally so the user
 * can navigate back from any page.
 * 
 * Shape of a tracked installation:
 * {
 *   id: string,
 *   clusterName: string,
 *   mode: 'install' | 'scale' | 'upgrade' | 'addon-only',
 *   status: 'running' | 'completed' | 'failed',
 *   progress: number (0-100),
 *   currentStep: string,
 *   startedAt: string (ISO)
 * }
 */
export function InstallationTrackerProvider({ children }) {
    const [activeInstallations, setActiveInstallations] = useState([])

    const trackInstallation = useCallback((installation) => {
        setActiveInstallations(prev => {
            const exists = prev.find(i => i.id === installation.id)
            if (exists) {
                // Update existing
                return prev.map(i => i.id === installation.id ? { ...i, ...installation } : i)
            }
            return [...prev, installation]
        })
    }, [])

    const updateInstallation = useCallback((id, updates) => {
        setActiveInstallations(prev =>
            prev.map(i => i.id === id ? { ...i, ...updates } : i)
        )
    }, [])

    const removeInstallation = useCallback((id) => {
        setActiveInstallations(prev => prev.filter(i => i.id !== id))
    }, [])

    const getRunningInstallations = useCallback(() => {
        return activeInstallations.filter(i => i.status === 'running')
    }, [activeInstallations])

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
