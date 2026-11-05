// The cluster opened last ({ id, name }), per browser — the sidebar's cluster
// section opens its tabs. Storage can be off (private window): then nothing is
// remembered and the section asks to choose a cluster.
const KEY = 'kz.lastCluster'

export function readLastCluster() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v?.id ? v : null } catch { return null }
}

export function rememberCluster(c) {
    const cur = readLastCluster()
    if (cur?.id === c.id && cur?.name === c.name) return
    try { localStorage.setItem(KEY, JSON.stringify({ id: c.id, name: c.name })) } catch { }
    window.dispatchEvent(new CustomEvent('kz-last-cluster', { detail: c }))
}

/** A cluster that is gone (removed, no access) is forgotten. */
export function forgetCluster(id) {
    if (readLastCluster()?.id !== id) return
    try { localStorage.removeItem(KEY) } catch { }
    window.dispatchEvent(new CustomEvent('kz-last-cluster', { detail: null }))
}
