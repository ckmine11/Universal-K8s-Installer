// What this browser keeps for the person signed in: the Ask AI conversation,
// the cluster opened last, running installations. Whoever signs in next on the
// same browser — or after signing out — starts fresh, never with someone
// else's data. (Theme and sidebar layout are the browser's, and stay.)
const LOCAL = ['kz.lastCluster', 'kubeez_active_installations', 'kubeez_dismissed_installations', 'scaleClusterData']
const SESSION = ['kz.ai.chat']
const OWNER = 'kz.owner'   // the user id these belong to

export function clearAccountData() {
    try { for (const k of LOCAL) localStorage.removeItem(k); localStorage.removeItem(OWNER) } catch { }
    try { for (const k of SESSION) sessionStorage.removeItem(k) } catch { }
    window.dispatchEvent(new CustomEvent('kz-last-cluster', { detail: null }))
}

/** Before a person's pages load: data of anyone else (or of nobody known) is dropped. */
export function claimBrowser(userId) {
    if (!userId) return
    let owner = null
    try { owner = localStorage.getItem(OWNER) } catch { }
    if (owner === String(userId)) return
    clearAccountData()
    try { localStorage.setItem(OWNER, String(userId)) } catch { }
}
