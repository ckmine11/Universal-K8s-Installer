import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Terminal, X, Zap, Loader2, Globe, Command, Lock, Clock, Circle } from 'lucide-react';
import { apiFetch } from '../context/AuthContext';

const OrbitalTerminal = ({ clusterId, nodes, onClose }) => {
    const [command, setCommand] = useState('');
    const [isBroadcasting, setIsBroadcasting] = useState(false);
    const [outputs, setOutputs] = useState({}); // ip -> string
    const terminalRef = useRef(null);
    const xtermRef = useRef(null);
    const wsRef = useRef(null);
    // Just-in-time access: a grant (reason + time limit) for this cluster
    const [access, setAccess] = useState(null);        // { active, grants, minutes, requireApproval }
    const [reason, setReason] = useState('');
    const [minutes, setMinutes] = useState(30);
    const [asking, setAsking] = useState(false);
    const [askError, setAskError] = useState('');
    const [now, setNow] = useState(Date.now());
    const loadAccess = async () => {
        const r = await apiFetch(`/api/terminal/grants/mine?clusterId=${encodeURIComponent(clusterId)}`);
        if (r.ok) setAccess(await r.json());
    };
    useEffect(() => {
        loadAccess();
        const t = setInterval(() => { setNow(Date.now()); }, 1000);
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
    // Admins (and everyone when the workspace needs no approval) go straight in:
    // the session opens by itself and is recorded — no form
    const autoTried = useRef(0);
    useEffect(() => {
        if (!access || active || pending || asking || !access.immediate) return;
        if (Date.now() - autoTried.current < 10000) return;   // once per 10 s, not a loop on errors
        autoTried.current = Date.now();
        askAccess(null, { clusterId });
    }, [access, active, pending, asking]);

    useEffect(() => {
        // Initialize XTerm for global view
        const term = new XTerm({
            theme: {
                background: 'transparent',
                foreground: '#60a5fa',
                cursor: '#60a5fa',
                selectionBackground: 'rgba(96, 165, 250, 0.3)'
            },
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 14,
            cursorBlink: true,
            allowTransparency: true
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(terminalRef.current);
        fitAddon.fit();
        xtermRef.current = term;

        term.writeln('\x1b[1;34mWelcome to the KubeEZ Terminal\x1b[0m');
        term.writeln('\x1b[32m[SYSTEM] Parallel SSH broadcasting active.\x1b[0m');
        term.writeln('\x1b[90mConnected to ' + nodes.length + ' node(s).\x1b[0m\r\n');

        // WebSocket Setup
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/orbital/${clusterId}`);
        wsRef.current = ws;

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'access-required') {
                term.writeln('\r\n\x1b[1;31m[ACCESS] ' + data.content + '\x1b[0m');
                loadAccess();
                return;
            }
            if (data.type === 'terminal-output') {
                const prefix = `\x1b[1;36m[${data.nodeIp}]\x1b[0m `;
                term.write(prefix + data.content.replace(/\n/g, '\r\n' + prefix));

                setOutputs(prev => ({
                    ...prev,
                    [data.nodeIp]: (prev[data.nodeIp] || '') + data.content
                }));
            }
        };

        return () => {
            ws.close();
            term.dispose();
        };
    }, [clusterId, nodes.length]);

    const handleBroadcast = (e) => {
        e.preventDefault();
        if (!command.trim() || isBroadcasting || !active) return;

        setIsBroadcasting(true);
        xtermRef.current.writeln(`\r\n\x1b[1;33m$ ${command}\x1b[0m`);

        wsRef.current.send(JSON.stringify({
            type: 'command',
            clusterId,
            nodes,
            command
        }));

        setCommand('');
        setTimeout(() => setIsBroadcasting(false), 2000); // UI throttle
    };

    // a portal: no animated / blurred parent can move or clip the full-screen window
    return createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-8 bg-black/60 backdrop-blur-md animate-in fade-in zoom-in duration-300">
            <div className="relative w-full max-w-6xl h-[80vh] bg-slate-900/80 backdrop-blur-2xl border border-white/10 rounded-[32px] shadow-2xl overflow-hidden flex flex-col">
                {/* Visual Glows */}
                <div className="absolute top-0 right-0 w-96 h-96 bg-blue-500/10 rounded-full blur-[100px] pointer-events-none"></div>
                <div className="absolute bottom-0 left-0 w-96 h-96 bg-purple-500/10 rounded-full blur-[100px] pointer-events-none"></div>

                {/* Header */}
                <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
                    <div className="flex items-center space-x-4">
                        <div className="p-3 bg-blue-500/20 rounded-2xl border border-blue-500/30">
                            <Terminal className="w-6 h-6 text-blue-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-black text-white flex items-center">
                                ORBITAL TERMINAL
                                <span className="ml-3 px-2 py-0.5 bg-blue-500/20 border border-blue-500/40 rounded text-[10px] text-blue-400 uppercase tracking-tighter">Broadcast Mode</span>
                            </h2>
                            <p className="text-xs text-slate-400 font-mono">Parallel SSH Gateway - Synchronized Execution</p>
                            {active && <p className="mt-1 flex items-center gap-2 text-[11px] text-amber-200"><Circle className="w-2.5 h-2.5 fill-red-500 text-red-500" /> Recorded session · access ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · {active.reason}</p>}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors text-slate-400 hover:text-white">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                {/* Main Dashboard */}
                <div className="flex-1 flex overflow-hidden">
                    {/* Left: Global Terminal Feed */}
                    <div className="flex-1 p-6 flex flex-col min-w-0">
                        <div className="flex-1 bg-black/40 rounded-2xl border border-white/5 p-4 overflow-hidden" ref={terminalRef}></div>

                        {!active && (
                            <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/5 p-4">
                                {!access || (access.immediate && !askError) ? <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Opening a recorded session…</div>
                                    : access.immediate ? (
                                        <div className="flex items-center gap-2 text-sm text-red-300">Could not open the session: {askError} <button onClick={() => { autoTried.current = 0; setAskError(''); }} className="ml-2 underline">Try again</button></div>
                                    )
                                    : pending ? (
                                        <div className="flex items-center gap-2 text-sm text-amber-100"><Clock className="w-4 h-4" /> Waiting for an admin to approve {pending.minutes} minutes of access ("{pending.reason}"). This window opens by itself once approved.</div>
                                    ) : (
                                        <form onSubmit={askAccess} className="flex flex-wrap items-center gap-2">
                                            <Lock className="w-4 h-4 text-amber-300" />
                                            <span className="text-sm text-amber-100">Terminal access is given for a limited time and every session is recorded.</span>
                                            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Why do you need it? (recorded)" className="flex-1 min-w-[14rem] bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200" />
                                            <select value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="bg-black/40 border border-white/10 rounded-xl px-2 py-2 text-sm text-slate-200">
                                                {(access.minutes || [15, 30, 60, 120]).map(m => <option key={m} value={m} className="bg-slate-950">{m} min</option>)}
                                            </select>
                                            <button disabled={asking || reason.trim().length < 5} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-sm font-bold">{asking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Get access'}</button>
                                            {askError && <span className="w-full text-xs text-red-300">{askError}</span>}
                                            {access.requireApproval && <span className="w-full text-[11px] text-slate-500">Operators need an admin's approval; admins get access at once (recorded).</span>}
                                        </form>
                                    )}
                            </div>
                        )}
                        <form onSubmit={handleBroadcast} className="mt-4 relative">
                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-blue-500">
                                <Command size={18} />
                            </div>
                            <input
                                autoFocus
                                type="text"
                                value={command}
                                onChange={(e) => setCommand(e.target.value)}
                                placeholder="Broadcast command to all nodes (e.g., uptime, free -m, apt update)..."
                                className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-12 text-blue-100 font-mono focus:outline-none focus:border-blue-500/50 transition-all placeholder:text-slate-600"
                            />
                            <button
                                type="submit"
                                disabled={isBroadcasting || !command.trim() || !active}
                                className="absolute right-2 top-2 bottom-2 px-6 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl transition-all flex items-center justify-center font-bold"
                            >
                                {isBroadcasting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap size={18} />}
                            </button>
                        </form>
                    </div>

                    {/* Right: Node Status Sidebar */}
                    <div className="w-64 border-l border-white/5 bg-black/20 p-6 overflow-y-auto">
                        <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-6">Active Nodes</h3>
                        <div className="space-y-4">
                            {nodes.map(node => (
                                <div key={node.ip} className="p-3 rounded-xl border border-white/5 bg-white/5">
                                    <div className="flex items-center space-x-2 mb-2">
                                        <Globe className="w-3 h-3 text-blue-400" />
                                        <span className="text-xs font-bold text-slate-300 truncate">{node.hostname || node.name}</span>
                                    </div>
                                    <div className="flex items-center space-x-2">
                                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                                        <span className="text-[10px] font-mono text-slate-500">{node.ip}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    , document.body);
};

export default OrbitalTerminal;
