import dns from 'dns/promises'
import net from 'net'

// Ranges that belong to the KubeEZ server's own network or are not routable.
// In SaaS mode a customer must never be able to make the KubeEZ server open
// connections there (probing / brute-forcing our internal services, cloud
// metadata at 169.254.169.254, …). Private customer servers are reached through
// their own Gateway Agent instead.
const BLOCKED_V4 = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
]
const v4num = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0

export function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const n = v4num(ip)
        return BLOCKED_V4.some(([base, bits]) => {
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
            return (n & mask) === (v4num(base) & mask)
        })
    }
    if (net.isIPv6(ip)) {
        const a = ip.toLowerCase()
        const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
        if (mapped) return isPrivateAddress(mapped[1])
        return a === '::' || a === '::1' || /^fe[89ab]/.test(a) || /^f[cd]/.test(a) || /^ff/.test(a)
    }
    return true // not an IP at all — treat as unsafe
}

/**
 * Throws when the KubeEZ server itself would open a DIRECT connection (no
 * Gateway Agent) to an internal address while running as SaaS. Hostnames are
 * resolved first, so a DNS name pointing at 127.0.0.1 is caught too.
 * Self-hosted installs (KubeEZ inside the customer's own network) are not limited.
 */
export async function assertDirectConnectAllowed(host) {
    if (process.env.KUBEEZ_MODE !== 'saas' || process.env.KUBEEZ_ALLOW_PRIVATE_SSH === 'true') return
    let addrs
    try {
        addrs = net.isIP(host) ? [host] : (await dns.lookup(String(host), { all: true })).map(a => a.address)
    } catch {
        throw new Error(`Cannot resolve "${host}". Check the address.`)
    }
    if (!addrs.length || addrs.some(isPrivateAddress)) {
        throw new Error(
            `${host} is a private/internal address. KubeEZ cloud reaches private servers only through your ` +
            `Gateway Agent — start it on the Tunnels page (it must be online), then try again.`)
    }
}
