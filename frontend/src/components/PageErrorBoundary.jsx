import { Component } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

// A page that fails to render never leaves a blank screen.
// - After a deploy, a tab that was already open may ask for a page file that no
//   longer exists ("Failed to fetch dynamically imported module"): reload once,
//   which fetches the new version.
// - Any other crash: say what broke, with a reload button — and the message to
//   pass on to support.
const CHUNK_FAILED = /dynamically imported module|Importing a module script failed|Loading chunk|ChunkLoadError|error loading dynamically imported/i
const RELOADED = 'kz-reloaded-after-deploy'

export function reloadIfStale(error) {
    if (!CHUNK_FAILED.test(String(error?.message || error))) return false
    try {
        // once per minute at most, so a real outage does not loop
        const last = Number(sessionStorage.getItem(RELOADED) || 0)
        if (Date.now() - last < 60e3) return false
        sessionStorage.setItem(RELOADED, String(Date.now()))
    } catch { }
    window.location.reload()
    return true
}

export default class PageErrorBoundary extends Component {
    state = { error: null }
    static getDerivedStateFromError(error) { return { error } }
    componentDidCatch(error, info) {
        if (reloadIfStale(error)) return
        console.error('[KubeEZ] page crashed:', error, info?.componentStack)
    }
    componentDidUpdate(prev) {
        // moving to another page clears the error
        if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
    }
    render() {
        const { error } = this.state
        if (!error) return this.props.children
        const stale = CHUNK_FAILED.test(String(error?.message || error))
        return (
            <div className="mx-auto max-w-xl py-16" role="alert">
                <div className="kz-card p-6">
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="mt-0.5 w-5 h-5 shrink-0 text-amber-400" />
                        <div className="min-w-0">
                            <h2 className="text-base font-semibold text-white">{stale ? 'KubeEZ was just updated' : 'This page could not be shown'}</h2>
                            <p className="mt-1 text-sm text-slate-400">{stale ? 'Reload to get the new version.' : 'Reloading usually fixes it. If it happens again, send this message to support:'}</p>
                            {!stale && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] text-slate-300">{String(error?.message || error)}</pre>}
                            <button type="button" onClick={() => window.location.reload()} className="kz-btn-primary mt-4 !text-sm"><RotateCcw className="w-4 h-4" /> Reload</button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }
}
