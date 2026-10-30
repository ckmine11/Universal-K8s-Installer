import { useEffect, useState } from 'react'
import { apiFetch } from '../context/AuthContext'

// Feature flags for the UI (the server enforces them — this only hides what is
// off). Loaded once after sign-in; until then everything counts as on.
let ENABLED = null
let loading = null
const subs = new Set()

export const featureOn = (key) => !ENABLED || ENABLED[key] !== false
export function setFeatures(enabled) { ENABLED = enabled || null; subs.forEach(f => f()) }
export function loadFeatures() {
    loading ||= apiFetch('/api/features').then(r => r.ok ? r.json() : null).then(d => { if (d) setFeatures(d.enabled) }).catch(() => { }).finally(() => { loading = null })
    return loading
}
/** Re-renders when the flags arrive or change; returns featureOn. */
export function useFeatures() {
    const [, tick] = useState(0)
    useEffect(() => {
        const f = () => tick(n => n + 1)
        subs.add(f)
        if (!ENABLED) loadFeatures()
        return () => subs.delete(f)
    }, [])
    return featureOn
}
