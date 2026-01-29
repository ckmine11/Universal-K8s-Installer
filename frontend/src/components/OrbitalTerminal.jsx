import React, { useState, useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Terminal, X, Zap, Loader2, Globe, Command } from 'lucide-react';

const OrbitalTerminal = ({ clusterId, nodes, onClose }) => {
    const [command, setCommand] = useState('');
    const [isBroadcasting, setIsBroadcasting] = useState(false);
    const [outputs, setOutputs] = useState({}); // ip -> string
    const terminalRef = useRef(null);
    const xtermRef = useRef(null);
    const wsRef = useRef(null);

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

        term.writeln('\x1b[1;34mWelcome to Orbit Terminal System v2.1.0\x1b[0m');
        term.writeln('\x1b[32m[SYSTEM] Parallel SSH broadcasting active.\x1b[0m');
        term.writeln('\x1b[90mConnected to ' + nodes.length + ' node(s).\x1b[0m\r\n');

        // WebSocket Setup
        const token = localStorage.getItem('token');
        const ws = new WebSocket(`ws://${window.location.hostname}:3000/ws/orbital/${clusterId}?token=${token}`);
        wsRef.current = ws;

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
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
        if (!command.trim() || isBroadcasting) return;

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

    return (
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
                                disabled={isBroadcasting || !command.trim()}
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
    );
};

export default OrbitalTerminal;
