import { lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'

// The two heavy pieces of the console — the 3D topology (three.js) and the
// terminal (xterm) — download only when they are first shown.
const Topology = lazy(() => import('./ClusterTopology3D'))
const Terminal = lazy(() => import('./OrbitalTerminal'))

export function ClusterTopology3D(props) {
    return (
        <Suspense fallback={<div className="grid h-full min-h-[300px] w-full place-items-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin" aria-label="Loading 3D view" /></div>}>
            <Topology {...props} />
        </Suspense>
    )
}

export function OrbitalTerminal(props) {
    return (
        <Suspense fallback={<div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"><Loader2 className="w-6 h-6 animate-spin text-slate-300" aria-label="Opening terminal" /></div>}>
            <Terminal {...props} />
        </Suspense>
    )
}
