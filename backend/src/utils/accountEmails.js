import { getMailer, mailConfigured, mailFrom, mailError } from './mailer.js'

// Account emails (welcome, team invite, reset code, password changed) in one
// KubeEZ look. Sending is best effort where noted: a missing or failing mail
// server never blocks sign-up.

const siteUrl = () => (process.env.KUBEEZ_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/+$/, '')
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function layout({ heading, intro, body = '', button, footer }) {
    const btn = button?.url
        ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">${esc(button.label)}</a></p>`
        : ''
    return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">
<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <div style="background:#0b101a;border-radius:14px 14px 0 0;padding:20px 28px">
    <span style="color:#ffffff;font-size:20px;font-weight:800;letter-spacing:.5px">Kube<span style="color:#60a5fa">EZ</span></span>
    <span style="color:#94a3b8;font-size:12px;margin-left:8px">Kubernetes made easy</span>
  </div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:28px;color:#1f2937;font-size:15px;line-height:1.6">
    <h2 style="margin:0 0 12px;font-size:20px;color:#111827">${heading}</h2>
    <p style="margin:0 0 12px">${intro}</p>
    ${body}
    ${btn}
    <p style="margin:24px 0 0;color:#6b7280;font-size:12px">${footer || 'You get this email because of your KubeEZ account.'}</p>
  </div>
</div></body></html>`
}

const li = (items) => `<ol style="margin:8px 0 0 18px;padding:0">${items.map(i => `<li style="margin:6px 0">${i}</li>`).join('')}</ol>`

export function welcomeEmail(user) {
    const url = siteUrl()
    const name = esc(user.username)
    return {
        subject: 'Welcome to KubeEZ 🎉',
        text: [
            `Hi ${user.username},`, '',
            'Welcome to KubeEZ — your account is ready.', '',
            'Get started:',
            '1. Sign in' + (url ? ` at ${url}` : ''),
            '2. Servers in a private network? Start a Gateway Agent (Tunnels page) — no inbound ports needed.',
            '3. Deploy New Cluster: add your nodes, pick the Kubernetes version and add-ons.',
            '4. Settings → Alerts: get told on Telegram, Slack, Teams, WhatsApp or email.', '',
            `Your username: ${user.username}`, '',
            'If you did not create this account, ignore this email.'
        ].join('\n'),
        html: layout({
            heading: `Welcome, ${name} 👋`,
            intro: 'Your KubeEZ account is ready. Install, upgrade, back up and run Kubernetes clusters on your own servers — from one console.',
            body: `<p style="margin:16px 0 0;font-weight:bold">Get started in a few minutes</p>` + li([
                '<b>Servers in a private network?</b> Start a Gateway Agent on the Tunnels page — no inbound ports needed.',
                '<b>Deploy New Cluster</b> — add your nodes, pick the Kubernetes version and add-ons; every step shows a live log.',
                '<b>Settings → Alerts</b> — get told on Telegram, Slack, Teams, WhatsApp or email.'
            ]) + `<p style="margin:16px 0 0;color:#374151">Your username: <b>${name}</b></p>`,
            button: url ? { url: `${url}/`, label: 'Open KubeEZ' } : null,
            footer: 'If you did not create this account, you can ignore this email.'
        })
    }
}

export function memberAddedEmail(user, { addedBy, role }) {
    const url = siteUrl()
    const roleText = { admin: 'Admin — everything in the workspace', operator: 'Operator — manage clusters, add-ons and backups', viewer: 'Viewer — read-only' }[role] || role
    return {
        subject: `${addedBy} added you to their KubeEZ workspace`,
        text: [
            `Hi ${user.username},`, '',
            `${addedBy} created a KubeEZ account for you.`,
            `Username: ${user.username}`, `Role: ${roleText}`, '',
            `Sign in${url ? ` at ${url}` : ''} with the password ${addedBy} gives you — or use "Forgot Password?" on the sign-in page to choose your own.`
        ].join('\n'),
        html: layout({
            heading: 'You were added to a KubeEZ workspace',
            intro: `<b>${esc(addedBy)}</b> created a KubeEZ account for you.`,
            body: `<table style="margin:8px 0;border-collapse:collapse;font-size:14px">
                <tr><td style="padding:4px 16px 4px 0;color:#6b7280">Username</td><td><b>${esc(user.username)}</b></td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#6b7280">Role</td><td>${esc(roleText)}</td></tr></table>
                <p style="margin:12px 0 0">Sign in with the password ${esc(addedBy)} gives you — or use <b>Forgot Password?</b> on the sign-in page to choose your own.</p>`,
            button: url ? { url: `${url}/`, label: 'Sign in to KubeEZ' } : null,
            footer: 'If you were not expecting this, tell the workspace admin or ignore this email.'
        })
    }
}

export function resetCodeEmail(user, code) {
    return {
        subject: 'Your KubeEZ password reset code',
        text: `Hi ${user.username},\n\nYour KubeEZ password reset code is: ${code}\n\nIt is valid for 15 minutes. If you did not ask for this, ignore this email — your password stays the same.`,
        html: layout({
            heading: 'Reset your password',
            intro: `Hi <b>${esc(user.username)}</b>, use this code on the KubeEZ sign-in page:`,
            body: `<div style="background:#f4f4f5;padding:14px 20px;text-align:center;letter-spacing:10px;font-size:30px;font-weight:800;color:#111827;border-radius:10px;margin:8px 0">${esc(code)}</div>
                <p style="margin:8px 0 0;color:#6b7280;font-size:13px">Valid for 15 minutes and for one use.</p>`,
            footer: 'If you did not ask for this, ignore this email — your password stays the same.'
        })
    }
}

export function passwordChangedEmail(user) {
    const url = siteUrl()
    return {
        subject: 'Your KubeEZ password was changed',
        text: `Hi ${user.username},\n\nThe password of your KubeEZ account was just changed with a reset code, and all other sessions were signed out.\n\nIf this was not you, reset your password again right away and tell your workspace admin.`,
        html: layout({
            heading: 'Your password was changed',
            intro: `Hi <b>${esc(user.username)}</b>, the password of your KubeEZ account was just changed with a reset code, and all other sessions were signed out.`,
            body: '<p style="margin:12px 0 0"><b>Not you?</b> Reset your password again right away and tell your workspace admin.</p>',
            button: url ? { url: `${url}/`, label: 'Open KubeEZ' } : null
        })
    }
}

/** Send now and throw on failure (reset codes — the user waits for it). */
export async function sendAccountEmail(to, mail) {
    return getMailer().sendMail({ from: mailFrom(), to, ...mail })
}

/** Fire and forget (welcome, invites, notices) — never blocks the caller. */
export function sendAccountEmailLater(to, mail, what) {
    if (!to || !mailConfigured()) return
    sendAccountEmail(to, mail).catch(e => console.error(`[auth] ${what} email failed:`, mailError(e)))
}
