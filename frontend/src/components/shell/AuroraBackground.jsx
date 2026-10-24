// The page background (one fixed layer). The console gets a still, faint
// light; `vivid` (the sign-in page) the slow moving iris light.
export default function AuroraBackground({ vivid = false }) {
    if (!vivid) return <div className="kz-aurora" aria-hidden="true" />
    return (
        <div className="kz-aurora kz-aurora-vivid" aria-hidden="true">
            <div className="blob b1 animate-aurora-1" />
            <div className="blob b2 animate-aurora-2" />
            <div className="blob b3 animate-aurora-3" />
            <div className="grid" />
            <div className="grain" />
        </div>
    )
}
