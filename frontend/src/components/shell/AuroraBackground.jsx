// The slow aurora light behind every page (one fixed layer, GPU-friendly).
export default function AuroraBackground() {
    return (
        <div className="kz-aurora" aria-hidden="true">
            <div className="blob b1 animate-aurora-1" />
            <div className="blob b2 animate-aurora-2" />
            <div className="blob b3 animate-aurora-3" />
            <div className="grid" />
            <div className="grain" />
        </div>
    )
}
