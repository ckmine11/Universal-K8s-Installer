import { useState, useEffect } from 'react'
import EtcdBackupPanel from '../EtcdBackupPanel'
import VolumeBackupPanel from '../VolumeBackupPanel'
import {
    ShieldCheck, Database, Cloud, HardDrive, LifeBuoy, ChevronRight, CheckCircle2,
    AlertTriangle, XCircle, Loader2, Sparkles
} from 'lucide-react'

const DAY = 24 * 60 * 60 * 1000
const ago = (iso) => {
    if (!iso) return null
    const h = (Date.now() - new Date(iso).getTime()) / 3600e3
    if (h < 1) return 'just now'
    if (h < 24) return `${Math.round(h)} h ago`
    return `${Math.round(h / 24)} days ago`
}

// state → look
const TONE = {
    good: { Icon: CheckCircle2, cls: 'text-emerald-300', ring: 'border-emerald-500/25 bg-emerald-500/[0.05]', glow: 'from-emerald-500/20' },
    warn: { Icon: AlertTriangle, cls: 'text-amber-300', ring: 'border-amber-500/25 bg-amber-500/[0.05]', glow: 'from-amber-500/20' },
    bad: { Icon: XCircle, cls: 'text-red-300', ring: 'border-red-500/25 bg-red-500/[0.05]', glow: 'from-red-500/20' },
    off: { Icon: AlertTriangle, cls: 'text-slate-400', ring: 'border-white/10 bg-white/[0.02]', glow: 'from-white/5' },
    load: { Icon: Loader2, cls: 'text-slate-500', ring: 'border-white/10 bg-white/[0.02]', glow: 'from-white/5' }
}
const POINTS = { good: 25, warn: 12, bad: 0, off: 0 }

// Everything the overview knows, from what the two panels loaded
function assess(etcd, vol) {
    const tiles = []
    const recs = []

    // 1. Cluster state (etcd)
    if (!etcd) tiles.push({ key: 'etcd', title: 'Cluster state', Icon: Database, tone: 'load', line: 'Checking…', tab: 'state' })
    else if (etcd.locked) tiles.push({ key: 'etcd', title: 'Cluster state', Icon: Database, tone: 'off', line: 'Pro feature', tab: 'state' })
    else if (etcd.error) tiles.push({ key: 'etcd', title: 'Cluster state', Icon: Database, tone: 'bad', line: 'Control-plane unreachable', tab: 'state' })
    else {
        const latest = (etcd.backups || [])[0]
        const age = latest ? (Date.now() - new Date(latest.created).getTime()) / DAY : Infinity
        const tone = age <= 7 ? 'good' : age <= 30 ? 'warn' : 'bad'
        tiles.push({ key: 'etcd', title: 'Cluster state', Icon: Database, tone, tab: 'state',
            line: latest ? `Last snapshot ${ago(latest.created)}${latest.verified ? ' · verified' : ''}` : 'No snapshot yet',
            sub: `${(etcd.backups || []).length} snapshots kept ${etcd.retentionDays || 45} days` })
        if (tone !== 'good') recs.push({ tone, text: latest ? `The newest etcd snapshot is ${Math.round(age)} days old — take a fresh one before risky changes.` : 'There is no etcd snapshot yet — take one now.', action: 'Take a snapshot', tab: 'state' })
    }

    // 2. Offsite copy
    if (etcd && !etcd.locked && !etcd.error) {
        const o = etcd.offsite || {}
        const latest = (etcd.backups || [])[0]
        const remote = new Set((o.remote || []).map(n => n.replace(/\.tar\.gz\.enc$/, '.db')))
        let tone, line
        if (!o.connected) { tone = 'bad'; line = 'Not connected' }
        else if (o.error) { tone = 'bad'; line = 'Storage error' }
        else if (o.warning) { tone = 'warn'; line = 'On a node of this cluster' }
        else if (latest && !remote.has(latest.filename)) { tone = 'warn'; line = 'Newest snapshot not uploaded yet' }
        else { tone = 'good'; line = `${remote.size} encrypted copies` }
        tiles.push({ key: 'offsite', title: 'Offsite copy', Icon: Cloud, tone, line, tab: 'offsite', sub: o.connected ? `${o.provider === 'aws' ? 'AWS S3' : 'S3'} · bucket ${o.bucket}` : 'S3, MinIO, R2, Wasabi…' })
        if (!o.connected) recs.push({ tone: 'bad', text: 'Snapshots live only on the control-plane disk — connect offsite storage so they survive losing that machine.', action: 'Connect storage', tab: 'offsite' })
        else if (o.warning) recs.push({ tone: 'warn', text: 'The offsite storage runs on this same cluster — if the cluster is lost, the backups go with it. Use another server or a cloud bucket.', action: 'Change storage', tab: 'offsite' })
        else if (o.error) recs.push({ tone: 'bad', text: `Offsite storage problem: ${o.error}`, action: 'Open offsite', tab: 'offsite' })

        // 4. Disaster recovery readiness
        const drTone = o.connected && !o.error && remote.size ? (o.warning ? 'warn' : 'good') : 'bad'
        tiles.push({ key: 'dr', title: 'Disaster recovery', Icon: LifeBuoy, tone: drTone, tab: 'offsite',
            line: drTone === 'good' ? 'Ready — rebuild from offsite' : drTone === 'warn' ? 'Only while this cluster lives' : 'Not possible yet',
            sub: drTone === 'bad' ? 'Needs offsite copies' : 'Certificates + etcd in every bundle' })
    } else if (etcd) {
        tiles.push({ key: 'offsite', title: 'Offsite copy', Icon: Cloud, tone: etcd.locked ? 'off' : 'load', line: etcd.locked ? 'Pro feature' : '—', tab: 'offsite' })
        tiles.push({ key: 'dr', title: 'Disaster recovery', Icon: LifeBuoy, tone: etcd.locked ? 'off' : 'load', line: etcd.locked ? 'Pro feature' : '—', tab: 'offsite' })
    }

    // 3. Volume data
    if (!vol) tiles.push({ key: 'vol', title: 'Volume data', Icon: HardDrive, tone: 'load', line: 'Checking…', tab: 'volumes' })
    else if (vol.locked) tiles.push({ key: 'vol', title: 'Volume data', Icon: HardDrive, tone: 'off', line: 'Pro feature', tab: 'volumes' })
    else if (!vol.config?.configured) {
        tiles.push({ key: 'vol', title: 'Volume data', Icon: HardDrive, tone: 'off', line: 'Not set up', sub: 'Databases & uploads are not backed up', tab: 'volumes' })
        recs.push({ tone: 'warn', text: 'Files inside persistent volumes (databases, uploads) are not backed up — set up Volume Backups.', action: 'Set up', tab: 'volumes' })
    } else if (!vol.installed) {
        tiles.push({ key: 'vol', title: 'Volume data', Icon: HardDrive, tone: 'bad', line: 'Velero not installed', tab: 'volumes' })
    } else {
        const ok = (vol.backups || []).find(b => b.phase === 'Completed')
        const storageOk = vol.storage?.phase === 'Available'
        const age = ok ? (Date.now() - new Date(ok.started).getTime()) / DAY : Infinity
        const tone = !storageOk || vol.staleOffsite ? 'bad' : age <= 7 && vol.schedule ? 'good' : 'warn'
        tiles.push({ key: 'vol', title: 'Volume data', Icon: HardDrive, tone, tab: 'volumes',
            line: !storageOk ? 'Storage unavailable' : ok ? `Last backup ${ago(ok.started)}` : 'No backup yet',
            sub: vol.schedule ? `Automatic: ${vol.schedule.cron}` : 'Automatic backups off' })
        if (vol.staleOffsite) recs.push({ tone: 'bad', text: 'The offsite storage keys changed — Velero still uses the old ones. Apply the new settings.', action: 'Fix now', tab: 'volumes' })
        else if (!storageOk) recs.push({ tone: 'bad', text: `Velero cannot use its storage: ${vol.storage?.message || 'unavailable'}`, action: 'Open', tab: 'volumes' })
        if (storageOk && !vol.schedule) recs.push({ tone: 'warn', text: 'Volume backups run only when you click — turn on automatic daily backups.', action: 'Turn on', tab: 'volumes' })
    }

    // keep tile order stable
    const order = ['etcd', 'offsite', 'vol', 'dr']
    tiles.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    const scored = tiles.filter(t => t.tone !== 'load')
    const score = scored.length === 4 ? scored.reduce((n, t) => n + POINTS[t.tone], 0) : null
    recs.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1))
    return { tiles, recs, score }
}

function ScoreRing({ score }) {
    const r = 46, c = 2 * Math.PI * r
    const pct = score ?? 0
    const color = score == null ? '#475569' : score >= 80 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171'
    const label = score == null ? 'Checking' : score >= 80 ? 'Well protected' : score >= 50 ? 'Partly protected' : 'At risk'
    return (
        <div className="relative w-36 h-36 shrink-0">
            <svg viewBox="0 0 110 110" className="w-full h-full -rotate-90">
                <circle cx="55" cy="55" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="9" />
                <circle cx="55" cy="55" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
                    strokeDasharray={c} strokeDashoffset={c - (pct / 100) * c}
                    style={{ transition: 'stroke-dashoffset 1s ease, stroke 0.5s', filter: `drop-shadow(0 0 6px ${color}66)` }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
                {score == null ? <Loader2 className="w-6 h-6 animate-spin text-slate-500" /> : <span className="text-4xl font-black text-white tabular-nums">{score}</span>}
                <span className="text-[9px] font-black uppercase tracking-widest mt-0.5" style={{ color }}>{label}</span>
            </div>
        </div>
    )
}

const TABS = [
    { key: 'state', label: 'Cluster state', hint: 'etcd snapshots', Icon: Database },
    { key: 'volumes', label: 'Volume data', hint: 'Velero', Icon: HardDrive },
    { key: 'offsite', label: 'Offsite & recovery', hint: 'S3 · disaster recovery', Icon: Cloud }
]

/**
 * Backups tab: how well is this cluster protected (score + four checks +
 * what to do next), then one section at a time.
 */
export default function BackupsTab({ clusterId, clusterName, masterIp, canManage, explorer = false }) {
    const [etcd, setEtcd] = useState(null)
    const [vol, setVol] = useState(null)
    const [sub, setSub] = useState(() => {
        const s = new URLSearchParams(window.location.search).get('section')
        return TABS.some(t => t.key === s) ? s : 'state'
    })
    const { tiles, recs, score } = assess(etcd, vol)
    const toneOf = (tab) => tiles.filter(t => t.tab === tab).map(t => t.tone)

    // keep the section in the address (refresh / share keeps it)
    useEffect(() => {
        const u = new URL(window.location.href)
        u.searchParams.set('section', sub)
        window.history.replaceState(window.history.state, '', u)
    }, [sub])

    const go = (tab) => { setSub(tab); document.getElementById('backup-sections')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }

    return (
        <div className="space-y-6">
            {/* ── Overview ── */}
            <div className="glass rounded-2xl border border-white/8 p-6 relative overflow-hidden">
                <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />
                <div className="absolute -bottom-24 -left-16 w-72 h-72 rounded-full bg-violet-500/10 blur-3xl pointer-events-none" />
                <div className="relative flex flex-col lg:flex-row gap-6">
                    <div className="flex items-center gap-5 lg:w-80 shrink-0">
                        <ScoreRing score={score} />
                        <div>
                            <div className="flex items-center gap-2 text-white font-black text-lg"><ShieldCheck className="w-5 h-5 text-emerald-400" /> Protection</div>
                            <p className="text-xs text-slate-400 mt-1 leading-relaxed">Cluster state, offsite copies, volume data and disaster recovery — checked live.</p>
                        </div>
                    </div>
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {tiles.map(t => {
                            const tone = TONE[t.tone]
                            return (
                                <button key={t.key} onClick={() => go(t.tab)}
                                    className={`group relative text-left rounded-xl border p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg ${tone.ring}`}>
                                    <div className={`absolute inset-0 rounded-xl bg-gradient-to-br ${tone.glow} to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none`} />
                                    <div className="relative flex items-start gap-3">
                                        <div className="p-2 rounded-lg bg-black/30 border border-white/5"><t.Icon className="w-4 h-4 text-slate-300" /></div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">{t.title}</span>
                                                <tone.Icon className={`w-4 h-4 ${tone.cls} ${t.tone === 'load' ? 'animate-spin' : ''}`} />
                                            </div>
                                            <p className={`text-sm font-bold mt-0.5 ${t.tone === 'good' ? 'text-white' : tone.cls}`}>{t.line}</p>
                                            {t.sub && <p className="text-[11px] text-slate-500 truncate">{t.sub}</p>}
                                        </div>
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                </div>

                {recs.length > 0 && (
                    <div className="relative mt-5 pt-4 border-t border-white/5">
                        <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2"><Sparkles className="w-3.5 h-3.5 text-amber-400" /> What to do next</p>
                        <div className="space-y-1.5">
                            {recs.slice(0, 4).map((r, i) => (
                                <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] border border-white/5 px-3 py-2">
                                    <span className="flex items-start gap-2 text-xs text-slate-300 min-w-0">
                                        <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${r.tone === 'bad' ? 'bg-red-400' : 'bg-amber-400'}`} /> {r.text}
                                    </span>
                                    <button onClick={() => go(r.tab)} className="flex items-center gap-0.5 text-[11px] font-bold text-blue-300 hover:text-blue-200 shrink-0">
                                        {r.action} <ChevronRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Sections ── */}
            <div id="backup-sections" className="scroll-mt-4">
                <div role="tablist" className="flex gap-1 p-1 rounded-2xl bg-black/30 border border-white/8 mb-4 overflow-x-auto">
                    {TABS.map(t => {
                        const tones = toneOf(t.key)
                        const dot = tones.includes('bad') ? 'bg-red-400' : tones.includes('warn') ? 'bg-amber-400' : tones.includes('good') ? 'bg-emerald-400' : 'bg-slate-600'
                        return (
                            <button key={t.key} role="tab" aria-selected={sub === t.key} onClick={() => setSub(t.key)}
                                className={`flex-1 min-w-[150px] flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-bold transition-all
                                    ${sub === t.key ? 'bg-white/10 text-white shadow-inner' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`}>
                                <t.Icon className="w-4 h-4" /> {t.label}
                                <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                                <span className="hidden md:inline text-[10px] font-medium text-slate-500">{t.hint}</span>
                            </button>
                        )
                    })}
                </div>

                {/* One etcd panel serves two sections (one load, one state) */}
                <div className={sub === 'volumes' ? 'hidden' : ''}>
                    <EtcdBackupPanel clusterId={clusterId} clusterName={clusterName} masterIp={masterIp} canManage={canManage}
                        view={sub === 'offsite' ? 'offsite' : 'snapshots'} onData={setEtcd} explorer={explorer} />
                </div>
                <div className={sub === 'volumes' ? '' : 'hidden'}>
                    <VolumeBackupPanel clusterId={clusterId} clusterName={clusterName} canManage={canManage} onData={setVol} />
                </div>
            </div>
        </div>
    )
}
