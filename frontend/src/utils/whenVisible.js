// A polling tick that does nothing while the tab is in the background — an
// open KubeEZ tab no longer polls the server all day. The next tick after the
// tab is shown again catches up.
export const whenVisible = (fn) => (...args) => { if (typeof document === 'undefined' || !document.hidden) return fn(...args) }
