import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Upload, HelpCircle, CheckCircle2, AlertTriangle, X, KeyRound } from 'lucide-react'
import { CopyBlock } from './connect/shared'
import useBackdropClose from './ui/useBackdropClose'

// The SSH private key of a server: paste it, or import the key file — with a
// step-by-step guide (Windows, macOS, Linux) for someone who has never made one.
// KubeEZ connects with the key itself (it never reads a path on your computer),
// and the key must not have a passphrase.

/** What kind of text this is → { ok, kind, problem } */
export function checkKey(text) {
    const t = String(text || '').trim()
    if (!t) return { ok: false }
    if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)\S* AAAA/.test(t)) return { ok: false, problem: 'This is the PUBLIC key (the .pub file). KubeEZ needs the PRIVATE key — the file with the same name without .pub.' }
    if (/^PuTTY-User-Key-File/m.test(t)) return { ok: false, problem: 'This is a PuTTY key (.ppk). Convert it: open PuTTYgen → Load this file → Conversions → Export OpenSSH key, then import that file.' }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t) || !/-----END [A-Z ]*PRIVATE KEY-----/.test(t)) return { ok: false, problem: 'This does not look like a private key. It should start with "-----BEGIN … PRIVATE KEY-----" and end with "-----END … PRIVATE KEY-----".' }
    if (/ENCRYPTED/.test(t)) return { ok: false, problem: 'This key is protected with a passphrase, which KubeEZ cannot use. Make a copy without it: ssh-keygen -p -f <key file> (enter the old passphrase, then leave the new one empty).' }
    const kind = /OPENSSH/.test(t) ? (t.length < 600 ? 'ED25519' : 'OpenSSH') : /RSA/.test(t) ? 'RSA' : /EC /.test(t) ? 'ECDSA' : 'Private'
    return { ok: true, kind }
}

const OS_LIST = [['windows', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux']]
const guessOs = () => { const ua = navigator.userAgent || ''; return /Windows/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'mac' : 'linux' }

function Guide({ onClose, onImport }) {
    const [os, setOs] = useState(guessOs)
    const backdrop = useBackdropClose(onClose)
    const win = os === 'windows'
    const keyPath = win ? '$env:USERPROFILE\\.ssh\\kubeez' : '~/.ssh/kubeez'
    const fileShown = win ? 'C:\\Users\\<you>\\.ssh\\kubeez' : '~/.ssh/kubeez'
    const copyCmd = win ? `Get-Content ${keyPath} -Raw | Set-Clipboard` : os === 'mac' ? 'pbcopy < ~/.ssh/kubeez' : 'cat ~/.ssh/kubeez'
    return createPortal(
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" {...backdrop}>
            <div className="glass w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-white/10" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Create an SSH key">
                <div className="flex items-start gap-3 p-5 border-b border-white/5">
                    <KeyRound className="w-5 h-5 text-blue-300 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <h3 className="text-white font-black">Create an SSH key and add it to your servers</h3>
                        <p className="text-xs text-slate-400 mt-0.5">About 2 minutes. KubeEZ logs in to your servers with this key to install Kubernetes.</p>
                    </div>
                    <button type="button" onClick={onClose} className="p-1 rounded-md text-slate-500 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
                </div>
                <div className="overflow-y-auto p-5 space-y-5 text-sm text-slate-300">
                    <div className="flex flex-wrap items-center gap-3">
                        <span className="text-xs text-slate-500">Your computer:</span>
                        <div className="inline-flex rounded-lg border border-white/10 p-0.5" role="tablist" aria-label="Your computer">
                            {OS_LIST.map(([id, label]) => (
                                <button key={id} type="button" role="tab" aria-selected={os === id} onClick={() => setOs(id)}
                                    className={`rounded-md px-3.5 py-1.5 text-xs font-semibold ${os === id ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>{label}</button>
                            ))}
                        </div>
                    </div>
                    <ol className="space-y-5 list-decimal pl-5 marker:text-slate-500 marker:font-bold">
                        <li className="space-y-2">
                            <p><b className="text-white">Make the key.</b> Open {win ? <b>PowerShell</b> : <b>Terminal</b>} on your computer and run this. When it asks for a passphrase, just press <b>Enter</b> twice (KubeEZ needs a key without a passphrase).</p>
                            <CopyBlock multiline text={`ssh-keygen -t ed25519 -C "kubeez" -f ${keyPath}`} />
                            <p className="text-xs text-slate-500">It makes two files: <code className="text-slate-300">kubeez</code> (the private key, for KubeEZ) and <code className="text-slate-300">kubeez.pub</code> (the public key, for your servers).</p>
                        </li>
                        <li className="space-y-2">
                            <p><b className="text-white">Put the public key on every server</b> (each control-plane and worker). Replace <code className="text-slate-300">SERVER_IP</code> with the server address, and <code className="text-slate-300">root</code> if you log in as another user:</p>
                            <CopyBlock multiline text={win
                                ? `type ${keyPath}.pub | ssh root@SERVER_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"`
                                : `ssh-copy-id -i ${keyPath}.pub root@SERVER_IP`} />
                            <p className="text-xs text-slate-500">It asks for that server&apos;s password one time. {win ? 'Windows 10 and 11 have ssh built in. If "ssh" is not found: Settings → System → Optional features → add "OpenSSH Client".' : os === 'mac' ? 'ssh-copy-id comes with macOS.' : 'No ssh-copy-id? Install "openssh-client" (Ubuntu/Debian) or "openssh-clients" (RHEL/Rocky/Alma).'}</p>
                        </li>
                        <li className="space-y-2">
                            <p><b className="text-white">Check it works.</b> This should print <code className="text-slate-300">ok</code> without asking for a password:</p>
                            <CopyBlock multiline text={`ssh -i ${keyPath} root@SERVER_IP "echo ok"`} />
                        </li>
                        <li className="space-y-2">
                            <p><b className="text-white">Import it into KubeEZ.</b> Click <b>Import key file</b> and choose <code className="text-slate-300">{fileShown}</code> (the file <b>without</b> .pub).</p>
                            <p className="text-xs text-slate-500">{os === 'mac' ? 'The .ssh folder is hidden: in the file picker press Cmd + Shift + . (dot) to show it, or Cmd + Shift + G and type ~/.ssh' : win ? 'In the file picker, type %USERPROFILE%\\.ssh in the address bar to open the folder.' : 'The .ssh folder is hidden: press Ctrl + H in the file picker to show it.'}</p>
                            <button type="button" onClick={() => { onClose(); onImport() }} className="kz-btn-primary !text-xs"><Upload className="w-3.5 h-3.5" /> Import key file</button>
                            <p className="text-xs text-slate-500 pt-1">Or copy the key and paste it into the box:</p>
                            <CopyBlock multiline text={copyCmd} />
                        </li>
                    </ol>
                    <div className="border-t border-white/10 pt-4 space-y-2 text-xs text-slate-400">
                        <p><b className="text-slate-200">Already have a key?</b> Use it. Common names: <code>id_ed25519</code>, <code>id_rsa</code>. A key from your cloud provider (for example an AWS <code>.pem</code> file) works as it is: import the .pem file.</p>
                        <p><b className="text-slate-200">PuTTY key (.ppk)?</b> Open PuTTYgen → <b>Load</b> your .ppk → <b>Conversions → Export OpenSSH key</b>, then import that file.</p>
                        <p><b className="text-slate-200">Key has a passphrase?</b> Remove it on a copy: <code>ssh-keygen -p -f &lt;key file&gt;</code> (old passphrase, then press Enter twice).</p>
                        <p><b className="text-slate-200">Is it safe?</b> KubeEZ stores the key encrypted and never shows it again. Use a key made just for KubeEZ, so you can remove its access later (delete its line from ~/.ssh/authorized_keys on the servers).</p>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    )
}

export default function SshKeyInput({ value, onChange, className = '' }) {
    const file = useRef(null)
    const [help, setHelp] = useState(false)
    const [note, setNote] = useState('')
    const check = checkKey(value)

    const importFile = async (f) => {
        setNote('')
        if (!f) return
        if (f.size > 64 * 1024) { setNote('That file is too big to be an SSH key.'); return }
        if (/\.pub$/i.test(f.name)) { setNote(`"${f.name}" is the PUBLIC key — choose the file with the same name without .pub.`); return }
        const text = (await f.text()).replace(/\r\n/g, '\n').trim()
        const c = checkKey(text)
        if (!c.ok) { setNote(c.problem || 'That file is not an SSH private key.'); return }
        onChange(`${text}\n`)
        setNote(`Imported ${f.name}.`)
    }

    const problem = (note && !check.ok) ? note : (value && !check.ok ? check.problem : '')
    return (
        <div className="flex-1 min-w-0">
            <textarea
                aria-label="SSH private key"
                placeholder="Paste the private key (starts with -----BEGIN … PRIVATE KEY-----) — or import the key file"
                className={`w-full min-h-[92px] px-5 py-3 rounded-xl bg-black/40 border border-white/10 outline-none placeholder:text-slate-600 font-mono text-xs ${className}`}
                value={value || ''}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => { setNote(''); onChange(e.target.value) }}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <input ref={file} type="file" className="hidden" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = '' }} />
                <button type="button" onClick={() => file.current?.click()} className="kz-btn-ghost !py-1.5 !px-3 !text-[11px]"><Upload className="w-3.5 h-3.5" /> Import key file</button>
                <button type="button" onClick={() => setHelp(true)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-white"><HelpCircle className="w-3.5 h-3.5" /> How do I get a key?</button>
                {value && check.ok && <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> {check.kind} key {note ? `— ${note}` : 'ready'}</span>}
            </div>
            {problem && <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-400" role="alert"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{problem}</p>}
            {help && <Guide onClose={() => setHelp(false)} onImport={() => file.current?.click()} />}
        </div>
    )
}
