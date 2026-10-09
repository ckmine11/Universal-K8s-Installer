import nodemailer from 'nodemailer'

// One SMTP transport for everything KubeEZ emails (password reset, alerts).
// Port 465 = TLS from the start; 587/25 = STARTTLS (SMTP_SECURE overrides).
// Timeouts keep a wrong host from hanging a request for minutes.

export const mailConfigured = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS)
export const mailFrom = () => process.env.EMAIL_FROM || process.env.SMTP_USER

let transport = null, transportKey = ''

export function getMailer() {
    if (!mailConfigured()) {
        throw Object.assign(new Error('Email is not set up on this server — set the SMTP settings (SMTP_HOST, SMTP_USER, SMTP_PASS)'), { code: 'NO_SMTP' })
    }
    const port = parseInt(process.env.SMTP_PORT, 10) || 465
    const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465
    const key = [process.env.SMTP_HOST, port, secure, process.env.SMTP_USER, process.env.SMTP_PASS].join('|')
    if (!transport || key !== transportKey) {
        transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port,
            secure,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
            connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
        })
        transportKey = key
    }
    return transport
}

/** Plain-words reason for an SMTP failure (for admins / logs). */
export function mailError(e) {
    const m = String(e?.message || e)
    if (e?.code === 'NO_SMTP') return m
    if (e?.code === 'EAUTH' || /Invalid login|Username and Password not accepted|535/.test(m)) return 'The SMTP server refused the login — check SMTP_USER / SMTP_PASS (Gmail needs an App Password, not your normal password).'
    if (e?.code === 'ETIMEDOUT' || e?.code === 'ECONNECTION' || e?.code === 'ESOCKET' || /timeout|ECONNREFUSED|ENOTFOUND/i.test(m)) return `Cannot reach the SMTP server (${process.env.SMTP_HOST || 'smtp.gmail.com'}:${process.env.SMTP_PORT || 465}) — check SMTP_HOST / SMTP_PORT and that the server may connect out on that port.`
    if (e?.code === 'EENVELOPE' || /recipient|550|553/i.test(m)) return `The mail server refused a recipient: ${m.slice(0, 160)}`
    return m
}
