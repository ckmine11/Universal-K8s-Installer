import { useState } from 'react'
import { Loader2, Server, KeyRound, Trash2, CheckCircle2, Info } from 'lucide-react'
import { useToast } from '../ToastProvider'
import { call } from './shared'
import SshKeyInput from '../SshKeyInput'

// SSH for an on-prem imported cluster: pick its nodes, give the logins — each
// node is checked (SSH works, it IS a node of this cluster) before it is kept.
// kubeadm: then like a cluster KubeEZ installed (etcd snapshots, upgrades, new
// nodes). Other distributions: node shells and node checks; the rest stays on the API.
export default function SshNodes({ c, onChanged }) {
    const { toast } = useToast()
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState(false)
    const [rows, setRows] = useState(() => (c.nodes || []).map(n => ({ name: n.name, role: n.role, on: n.role === 'control-plane', ip: n.ip || '', username: 'root', auth: 'password', secret: '' })))
    const set = (i, patch) => setRows(r => r.map((x, k) => k === i ? { ...x, ...patch } : x))
    const save = async () => {
        const nodes = rows.filter(r => r.on).map(r => ({ ip: r.ip.trim(), username: r.username.trim(), ...(r.auth === 'password' ? { password: r.secret } : { sshKey: r.secret }) }))
        if (!nodes.length) return toast({ title: 'Pick at least one node', type: 'error' })
        setBusy(true)
        try {
            const r = await call(`/api/connect/clusters/${c.id}/ssh`, { method: 'PUT', body: { nodes } })
            setRows(rs => rs.map(x => ({ ...x, secret: '' })))   // never kept in the page
            toast({ title: 'SSH added', message: r.mode === 'kubeadm' ? 'kubeadm: etcd snapshots, upgrades and new nodes now work like on clusters KubeEZ installed.' : 'Node shells and node checks now work over SSH.', type: 'success' })
            setOpen(false); onChanged()
        } catch (e) { toast({ title: 'Not added', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }
    const remove = async () => {
        if (!window.confirm('Forget the SSH logins? KubeEZ goes back to the Kubernetes API only (etcd snapshots, upgrades and node shells stop).')) return
        setBusy(true)
        try { await call(`/api/connect/clusters/${c.id}/ssh`, { method: 'DELETE' }); toast({ title: 'SSH removed', type: 'success' }); onChanged() }
        catch (e) { toast({ title: 'Not removed', message: e.message, type: 'error' }) } finally { setBusy(false) }
    }

    if (c.sshAdded) return (
        <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-[11px] text-emerald-200"><CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />{c.sshMode === 'kubeadm' ? 'SSH added — kubeadm: etcd snapshots, upgrades and new nodes work like on clusters KubeEZ installed.' : 'SSH added — node shells and node checks. The rest stays on the Kubernetes API.'}</p>
            <ul className="space-y-1 text-[11px] text-slate-300">{(c.sshNodes || []).map(n => <li key={n.ip} className="flex items-center gap-1.5"><Server className="w-3 h-3 text-slate-500" /><span className="font-mono">{n.hostname || n.ip}</span><span className="text-slate-500">{n.ip} · {n.username} · {n.role}</span></li>)}</ul>
            <button type="button" disabled={busy} onClick={remove} className="kz-btn-ghost !text-xs w-full justify-start"><Trash2 className="w-3.5 h-3.5" /> Remove SSH</button>
        </div>
    )
    if (!open) return (
        <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-[11px] text-slate-400"><Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />SSH to the nodes unlocks node shells and node checks — and on kubeadm clusters etcd snapshots, upgrades and new nodes.</p>
            <button type="button" onClick={() => setOpen(true)} className="kz-btn-ghost !text-xs w-full justify-start"><KeyRound className="w-3.5 h-3.5" /> Add SSH</button>
        </div>
    )
    return (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-[11px] text-slate-400">Pick the nodes (a control-plane at least; for upgrades every node). Each is checked before it is kept. Logins are stored encrypted.</p>
            {rows.map((r, i) => (
                <div key={r.name} className={`space-y-1.5 rounded-lg border p-2 ${r.on ? 'border-blue-400/30' : 'border-white/5 opacity-70'}`}>
                    <label className="flex items-center gap-2 text-xs text-slate-200"><input type="checkbox" checked={r.on} onChange={e => set(i, { on: e.target.checked })} /><span className="font-mono">{r.name}</span><span className="text-[10px] text-slate-500">{r.role}</span></label>
                    {r.on && (
                        <div className="grid grid-cols-2 gap-1.5">
                            <input aria-label="Address" className="kz-input !py-1 !text-xs font-mono" value={r.ip} onChange={e => set(i, { ip: e.target.value })} placeholder="IP or hostname" />
                            <input aria-label="SSH user" className="kz-input !py-1 !text-xs" value={r.username} onChange={e => set(i, { username: e.target.value })} placeholder="root" />
                            <select aria-label="Login" className="kz-input !py-1 !text-xs" value={r.auth} onChange={e => set(i, { auth: e.target.value, secret: '' })}><option value="password">Password</option><option value="key">SSH key</option></select>
                            {r.auth === 'password'
                                ? <input aria-label="Password" type="password" autoComplete="new-password" className="kz-input !py-1 !text-xs" value={r.secret} onChange={e => set(i, { secret: e.target.value })} placeholder="password" />
                                : <div className="col-span-2"><SshKeyInput value={r.secret} onChange={v => set(i, { secret: v })} className="!min-h-[64px] !px-3 !py-2 !text-[10px]" /></div>}
                        </div>
                    )}
                </div>
            ))}
            <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="kz-btn-ghost !text-xs">Cancel</button>
                <button type="button" disabled={busy} onClick={save} className="kz-btn-primary !text-xs">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />} Check and add</button>
            </div>
        </div>
    )
}
