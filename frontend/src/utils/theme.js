// The look of every page — public pages and the console:
//   zen   (default) warm off-white, acid-lime accent, monospace headings
//   dark  the near-black "Midnight" look
// Stored per browser; set on <html> before the first paint (main.jsx), so a
// page never flashes the other theme. `light` (the earlier light theme) is
// shown as zen.
export const THEMES = ['zen', 'dark']
const KEY = 'kz-theme'

export function getTheme() {
    try { const t = localStorage.getItem(KEY); return t === 'dark' ? 'dark' : 'zen' } catch { return 'zen' }
}

export function applyTheme(theme = getTheme()) {
    const el = document.documentElement
    if (theme === 'dark') { delete el.dataset.theme; delete el.dataset.skin }
    else { el.dataset.theme = 'light'; el.dataset.skin = 'zen' }   // zen = the light palette + the lime skin
    el.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
}

export function setTheme(theme) {
    try { localStorage.setItem(KEY, theme) } catch { }
    applyTheme(theme)
    window.dispatchEvent(new CustomEvent('kz-theme', { detail: theme }))
}
