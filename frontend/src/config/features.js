import { useEffect, useState } from 'react'
import { apiFetch } from '../context/AuthContext'

// Feature flags for the UI (the server enforces them — this only hides what is
// off). Loaded once after sign-in; until then everything counts as on.
// A feature can be on but outside the workspace's plan (a Pro feature on Free):
// featureIncluded() says so, and the UI shows it with an upgrade card instead of
// loading it.
let ENABLED = null
let INCLUDED = null   // key → false when the plan does not include it
let LABELS = {}
let loading = null
const subs = new Set()

export const featureOn = (key) => !ENABLED || ENABLED[key] !== false
export const featureIncluded = (key) => !INCLUDED || INCLUDED[key] !== false
/** On and in the plan: safe to load. No until the plan is known, so nothing asks before. */
export const featureUsable = (key) => !!INCLUDED && featureOn(key) && featureIncluded(key)
export const featuresKnown = () => !!INCLUDED
export const featureLabel = (key) => LABELS[key] || key
/** enabled: { key: bool }; list: GET /api/features → features (with included, label). */
export function setFeatures(enabled, list) {
    ENABLED = enabled || null
    if (Array.isArray(list)) {
        INCLUDED = Object.fromEntries(list.map(f => [f.key, f.included !== false]))
        LABELS = Object.fromEntries(list.map(f => [f.key, f.label]))
    }
    subs.forEach(f => f())
}
/** Signed out or another person signed in: load theirs. */
export function forgetFeatures() { ENABLED = null; INCLUDED = null; LABELS = {}; subs.forEach(f => f()) }
// another person signed in (AuthContext sends kz-user): their workspace's flags and plan
window.addEventListener('kz-user', (e) => { forgetFeatures(); if (e.detail) loadFeatures() })
export function loadFeatures() {
    loading ||= apiFetch('/api/features').then(r => r.ok ? r.json() : null).then(d => { if (d) setFeatures(d.enabled, d.features) }).catch(() => { }).finally(() => { loading = null })
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
