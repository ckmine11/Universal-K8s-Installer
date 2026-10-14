import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Terminal, X, Zap, Loader2, Server, Command, Lock, Clock, Circle, Plug, Radio } from 'lucide-react';
import { apiFetch } from '../context/AuthContext';

const wsBase = () => `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;
const theme = { background: '#0b0f19', foreground: '#e2e8f0', cursor: '#60a5fa', selectionBackground: 'rgba(96, 165, 250, 0.3)' };

// One node's interactive shell (xterm ⇄ /ws/shell ⇄ SSH)
function NodeShell({ clusterId, node, visible, onState }) {
    const box = useRef(null);
    const term = useRef(null);
    const fit = useRef(null);
    useEffect(() => {
        const t = new XTerm({ theme, fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000 });
        const f = new FitAddon();
        t.loadAddon(f);
        t.open(box.current);
        try { f.fit(); } catch { }
        term.current = t; fit.current = f;
        t.writeln(`\x1b[90mConnecting to ${node.hostname || node.name || node.ip} (${node.ip})…\x1b[0m`);
        const ws = new WebSocket(`${wsBase()}/ws/shell/${encodeURIComponent(clusterId)}?node=${encodeURIComponent(node.ip)}&cols=${t.cols}&rows=${t.rows}`);
        ws.onmessage = (e) => {
            const m = JSON.parse(e.data);
            if (m.type === 'output') t.write(m.data);
            else if (m.type === 'ready') { onState?.('connected'); t.focus(); }
            else if (m.type === 'status') t.writeln(`\x1b[90m${m.message}\x1b[0m`);
            else if (m.type === 'error' || m.type === 'access-required') { t.writeln(`\r\n\x1b[1;31m${m.message}\x1b[0m`); onState?.('error'); }
        };
        ws.onclose = () => { t.writeln('\r\n\x1b[90m[session closed]\x1b[0m'); onState?.('closed'); };
        const input = t.onData(d => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
        const resize = t.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
        const ro = new ResizeObserver(() => { try { f.fit(); } catch { } });
        ro.observe(box.current);
        return () => { ro.disconnect(); input.dispose(); resize.dispose(); ws.close(); t.dispose(); };
    }, [clusterId, node.ip]);
    useEffect(() => { if (visible) { setTimeout(() => { try { fit.current?.fit(); term.current?.focus(); } catch { } }, 30); } }, [visible]);
    return <div ref={box} className={`absolute inset-0 p-2 ${visible ? '' : 'invisible'}`} />;
}

// Run one command on several nodes at once (the former Orbital Terminal)
function Broadcast({ clusterId, nodes, visible }) {
    const box = useRef(null);
    const term = useRef(null);
    const ws = useRef(null);
    const [command, setCommand] = useState('');
    const [selected, setSelected] = useState(() => new Set(nodes.map(n => n.ip)));
    useEffect(() => {
        const t = new XTerm({ theme, fontFamily: '"JetBrains Mono", Menlo, monospace', fontSize: 13, scrollback: 5000, disableStdin: true });
        const f = new FitAddon();
        t.loadAddon(f); t.open(box.current); try { f.fit(); } catch { }
        term.current = t;
        t.writeln('\x1b[1;34mRun one command on the selected nodes\x1b[0m \x1b[90m(output is prefixed with the node)\x1b[0m');
        const s = new WebSocket(`${wsBase()}/ws/orbital/${clusterId}`);
        ws.current = s;
        s.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if (d.type === 'access-required') return t.writeln('\r\n\x1b[1;31m[ACCESS] ' + d.content + '\x1b[0m');
            if (d.type === 'terminal-output') {
                const p = `\x1b[1;36m[${d.nodeIp}]\x1b[0m `;
                t.write(p + d.content.replace(/\n/g, '\r\n' + p));
            }
        };
        const ro = new ResizeObserver(() => { try { f.fit(); } catch { } });
        ro.observe(box.current);
        return () => { ro.disconnect(); s.close(); t.dispose(); };
    }, [clusterId]);
    const run = (e) => {
        e.preventDefault();
        if (!command.trim() || !selected.size) return;
        term.current.writeln(`\r\n\x1b[1;33m$ ${command}\x1b[0m \x1b[90m(${selected.size} node${selected.size === 1 ? '' : 's'})\x1b[0m`);
        ws.current?.send(JSON.stringify({ type: 'command', clusterId, nodes: nodes.filter(n => selected.has(n.ip)), command }));
        setCommand('');
    };
    return (
        <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible'}`}>
            <div className="flex flex-wrap gap-2 p-2 text-xs">
                {nodes.map(n => (
                    <label key={n.ip} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border cursor-pointer ${selected.has(n.ip) ? 'border-blue-400/40 bg-blue-500/10 text-blue-100' : 'border-white/10 text-slate-400'}`}>
                        <input type="checkbox" checked={selected.has(n.ip)} onChange={() => setSelected(s => { const x = new Set(s); x.has(n.ip) ? x.delete(n.ip) : x.add(n.ip); return x; })} />
                        {n.hostname || n.name || n.ip}
                    </label>
                ))}
            </div>
            <div ref={box} className="flex-1 min-h-0 px-2" />
            <form onSubmit={run} className="p-2 relative">
                <Command size={16} className="absolute left-5 top-1/2 -translate-y-1/2 text-blue-400" />
                <input value={command} onChange={e => setCommand(e.target.value)} placeholder="Command for the selected nodes (e.g. uptime, df -h)…"
                    className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-10 pr-24 text-blue-100 font-mono text-sm focus:outline-none focus:border-blue-500/50" />
                <button disabled={!command.trim() || !selected.size} className="absolute right-4 top-3.5 bottom-3.5 px-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1"><Zap size={14} /> Run</button>
            </form>
        </div>
    );
}

const OrbitalTerminal = ({ clusterId, nodes, onClose }) => {
    // Just-in-time access: a grant (reason + time limit) for this cluster
    const [access, setAccess] = useState(null);
    const [reason, setReason] = useState('');
    const [minutes, setMinutes] = useState(30);
    const [asking, setAsking] = useState(false);
    const [askError, setAskError] = useState('');
    const [now, setNow] = useState(Date.now());
    const [tabs, setTabs] = useState([]);              // [{ key, node | null (broadcast) }]
    const [current, setCurrent] = useState(null);
    const [states, setStates] = useState({});          // key → connected | closed | error

    const loadAccess = async () => {
        const r = await apiFetch(`/api/terminal/grants/mine?clusterId=${encodeURIComponent(clusterId)}`);
        if (r.ok) setAccess(await r.json());
    };
    useEffect(() => {
        loadAccess();
        const t = setInterval(() => setNow(Date.now()), 1000);
        const p = setInterval(loadAccess, 5000);
        return () => { clearInterval(t); clearInterval(p); };
    }, [clusterId]);
    const active = access?.active && Date.parse(access.active.expiresAt) > now ? access.active : null;
    const pending = access?.grants?.find(g => g.status === 'pending');
    const left = active ? Math.max(0, Math.round((Date.parse(active.expiresAt) - now) / 1000)) : 0;
    const askAccess = async (e, body = { clusterId, reason, minutes }) => {
        e?.preventDefault();
        setAsking(true); setAskError('');
        try {
            const r = await apiFetch('/api/terminal/grants', { method: 'POST', body: JSON.stringify(body) });
            const j = await r.json();
            if (!r.ok) setAskError(j.error || 'Not possible');
            await loadAccess();
        } finally { setAsking(false); }
    };
    // Admins (and everyone when the workspace needs no approval) go straight in: recorded, no form
    const autoTried = useRef(0);
    useEffect(() => {
        if (!access || active || pending || asking || !access.immediate) return;
        if (Date.now() - autoTried.current < 10000) return;
        autoTried.current = Date.now();
        askAccess(null, { clusterId });
    }, [access, active, pending, asking]);

    const open = (node) => {
        const key = node ? node.ip : 'broadcast';
        setTabs(t => t.some(x => x.key === key) ? t : [...t, { key, node }]);
        setCurrent(key);
    };
    const closeTab = (key) => {
        setTabs(t => {
            const rest = t.filter(x => x.key !== key);
            if (current === key) setCurrent(rest.length ? rest[rest.length - 1].key : null);
            return rest;
        });
    };
    const label = (n) => n.hostname || n.name || n.ip;

    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-8 bg-black/60 backdrop-blur-md">
            <div className="relative w-full max-w-7xl h-[85vh] bg-slate-900/90 border border-white/10 rounded-3xl shadow-2xl overflow-hidden flex flex-col">
                {/* Header */}
                <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between bg-white/5">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-blue-500/20 rounded-xl border border-blue-500/30"><Terminal className="w-5 h-5 text-blue-400" /></div>
                        <div>
                            <h2 className="text-lg font-black text-white">Cluster terminal</h2>
                            {active ? <p className="flex items-center gap-2 text-[11px] text-amber-200"><Circle className="w-2.5 h-2.5 fill-red-500 text-red-500" /> Recorded · access ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · {active.reason}</p>
                                : <p className="text-[11px] text-slate-400">Pick a node to open its shell</p>}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl text-slate-400 hover:text-white" aria-label="Close"><X className="w-5 h-5" /></button>
                </div>

                <div className="flex-1 flex min-h-0">
                    {/* Nodes */}
                    <div className="w-60 shrink-0 border-r border-white/5 bg-black/20 p-3 overflow-y-auto">
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-3">Nodes</div>
                        <div className="space-y-2">
                            {nodes.map(n => {
                                const st = states[n.ip];
                                const isOpen = tabs.some(t => t.key === n.ip);
                                return (
                                    <div key={n.ip} className={`p-2.5 rounded-xl border ${current === n.ip ? 'border-blue-400/40 bg-blue-500/10' : 'border-white/5 bg-white/[0.03]'}`}>
                                        <div className="flex items-center gap-2">
                                            <Server className="w-3.5 h-3.5 text-blue-300 shrink-0" />
                                            <span className="text-xs font-bold text-slate-200 truncate">{label(n)}</span>
                                            {st === 'connected' && <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400" title="connected" />}
                                        </div>
                                        <div className="text-[10px] font-mono text-slate-500 mt-0.5">{n.ip}{n.role ? ` · ${n.role}` : ''}</div>
                                        <button disabled={!active} onClick={() => open(n)} className="mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-bold bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white">
                                            <Plug className="w-3.5 h-3.5" /> {isOpen ? 'Show shell' : 'Connect'}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        {nodes.length > 1 && (
                            <button disabled={!active} onClick={() => open(null)} className="mt-4 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-bold border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-slate-200">
                                <Radio className="w-3.5 h-3.5" /> Run on several nodes
                            </button>
                        )}
                    </div>

                    {/* Shells */}
                    <div className="flex-1 min-w-0 flex flex-col">
                        {!active && (
                            <div className="m-4 rounded-2xl border border-amber-400/20 bg-amber-500/5 p-4">
                                {!access || (access.immediate && !askError) ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Opening a recorded session…</div>
                                    : access.immediate ? (
                                        <div className="flex items-center gap-2 text-sm text-red-300">Could not open the session: {askError} <button onClick={() => { autoTried.current = 0; setAskError(''); }} className="ml-2 underline">Try again</button></div>
                                    ) : pending ? (
                                        <div className="flex items-center gap-2 text-sm text-amber-100"><Clock className="w-4 h-4" /> Waiting for an admin to approve {pending.minutes} minutes of access ("{pending.reason}"). This opens by itself once approved.</div>
                                    ) : (
                                        <form onSubmit={askAccess} className="flex flex-wrap items-center gap-2">
                                            <Lock className="w-4 h-4 text-amber-300" />
                                            <span className="text-sm text-amber-100">Terminal access is given for a limited time and every session is recorded.</span>
                                            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why do you need it? (an admin approves it)" className="flex-1 min-w-[14rem] bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200" />
                                            <select value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="bg-black/40 border border-white/10 rounded-xl px-2 py-2 text-sm text-slate-200">
                                                {(access.minutes || [15, 30, 60, 120]).map(m => <option key={m} value={m} className="bg-slate-950">{m} min</option>)}
                                            </select>
                                            <button disabled={asking || reason.trim().length < 5} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-sm font-bold">{asking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Ask for access'}</button>
                                            {askError && <span className="w-full text-xs text-red-300">{askError}</span>}
                                        </form>
                                    )}
                            </div>
                        )}
                        {tabs.length > 0 && (
                            <div className="flex items-center gap-1 px-2 pt-2 border-b border-white/5 overflow-x-auto">
                                {tabs.map(t => (
                                    <div key={t.key} onClick={() => setCurrent(t.key)} className={`flex items-center gap-2 px-3 py-1.5 rounded-t-lg text-xs cursor-pointer ${current === t.key ? 'bg-[#0b0f19] text-white' : 'text-slate-400 hover:text-white'}`}>
                                        {t.node ? <Server className="w-3 h-3" /> : <Radio className="w-3 h-3" />}
                                        {t.node ? label(t.node) : 'Several nodes'}
                                        {t.node && states[t.key] === 'connected' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                                        <button onClick={(e) => { e.stopPropagation(); closeTab(t.key); }} className="text-slate-500 hover:text-white" aria-label="Close tab"><X className="w-3 h-3" /></button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="relative flex-1 min-h-0 bg-[#0b0f19]">
                            {active && !tabs.length && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 text-sm gap-2">
                                    <Plug className="w-8 h-8 text-slate-600" />
                                    Click <b className="text-slate-300">Connect</b> next to a node to open its shell.
                                </div>
                            )}
                            {active && tabs.map(t => t.node
                                ? <NodeShell key={t.key} clusterId={clusterId} node={t.node} visible={current === t.key} onState={(s) => setStates(x => ({ ...x, [t.key]: s }))} />
                                : <Broadcast key={t.key} clusterId={clusterId} nodes={nodes} visible={current === t.key} />)}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    , document.body);
};

export default OrbitalTerminal;
