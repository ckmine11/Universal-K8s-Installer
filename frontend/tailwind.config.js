/** @type {import('tailwindcss').Config} */

// KubeEZ "Midnight" theme (after Linear / Vercel: neutral near-black, crisp
// borders, colour only where it means something).
// The whole app is built with Tailwind's colour names, so the theme remaps
// them in one place: `blue` becomes iris (the brand violet-blue), `slate`
// becomes graphite (a neutral grey on near-black). Emerald / amber / red keep
// meaning success / warning / danger; cyan and sky are the second accent.
const iris = {
    50: '#f3f1ff',
    100: '#e8e4ff',
    200: '#d4ccff',
    300: '#b6a8ff',
    400: '#9a87ff',
    500: '#8069fb',
    600: '#6b4ff0',
    700: '#5a3ed6',
    800: '#4932ad',
    900: '#3c2b88',
    950: '#221852',
}
const graphite = {
    // neutral (untinted) greys, Linear-style; 400 on the page = 6:1, 500 = 4.5:1
    50: '#f7f8f8',
    100: '#eeeff1',
    200: '#d6d8dc',
    300: '#b6b9bf',
    400: '#8f949c',
    500: '#71757d',
    600: '#4f5258',
    700: '#36383d',
    800: '#232428',
    900: '#151619',
    950: '#0c0d0f',
}

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const themed = Object.fromEntries(['blue', 'slate', 'emerald', 'amber', 'red', 'sky', 'purple', 'violet', 'rose', 'gray', 'cyan', 'fuchsia', 'orange', 'yellow', 'green', 'indigo', 'pink', 'teal', 'lime']
    .map(n => [n, Object.fromEntries(SHADES.map(s => [s, `rgb(var(--c-${n}-${s}) / <alpha-value>)`]))]))

export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                // every palette is a theme variable (src/theme-vars.css): the
                // same classes render dark or light; light flips each scale
                ...themed,
                white: 'rgb(var(--c-white) / <alpha-value>)',
                black: 'rgb(var(--c-black) / <alpha-value>)',
                iris: themed.blue,
                graphite: themed.slate,
                // older names, kept so nothing breaks
                aurora: themed.blue,
                night: themed.slate,
                // tokens used by the Lightswind components
                primary: { ...iris, DEFAULT: iris[500], foreground: '#ffffff' },
                primarylw: iris[500],
                secondary: { DEFAULT: themed.slate[400], foreground: themed.slate[100] },
                foreground: themed.slate[100],
                background: '#08090a',
                k8s: {
                    blue: '#326CE5',
                    lightblue: '#4A90E2',
                    dark: '#0F1419',
                }
            },
            fontFamily: {
                sans: ['"Geist Variable"', 'Geist', 'Inter', 'system-ui', 'sans-serif'],
                display: ['"Geist Variable"', 'Geist', 'Inter', 'sans-serif'],
                serif: ['"Instrument Serif"', 'Georgia', 'serif'],
                mono: ['"Geist Mono Variable"', '"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
            },
            opacity: { 3: '0.03', 8: '0.08' },
            boxShadow: {
                glow: '0 0 0 1px rgba(128,105,251,.28), 0 10px 40px -10px rgba(128,105,251,.45)',
                'glow-violet': '0 0 0 1px rgba(128,105,251,.28), 0 10px 40px -10px rgba(128,105,251,.45)',
                'glow-cyan': '0 0 0 1px rgba(56,189,248,.25), 0 10px 40px -10px rgba(56,189,248,.4)',
                glass: 'inset 0 1px 0 0 rgba(255,255,255,.06), 0 20px 50px -20px rgba(0,0,0,.7)',
            },
            backgroundImage: {
                // iris → sapphire → aqua: the brand gradient
                'aurora-gradient': 'linear-gradient(135deg, #8069fb 0%, #4f7dff 55%, #38bdf8 100%)',
                'iris-gradient': 'linear-gradient(135deg, #8069fb 0%, #4f7dff 55%, #38bdf8 100%)',
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'spin-slow': 'spin 3s linear infinite',
                'aurora-1': 'aurora1 28s ease-in-out infinite alternate',
                'aurora-2': 'aurora2 34s ease-in-out infinite alternate',
                'aurora-3': 'aurora3 40s ease-in-out infinite alternate',
                'shine': 'shine 6s linear infinite',
                'float': 'float 8s ease-in-out infinite',
                'marquee': 'marquee 40s linear infinite',
            },
            keyframes: {
                aurora1: { '0%': { transform: 'translate(-10%, -10%) rotate(0deg) scale(1)' }, '100%': { transform: 'translate(15%, 10%) rotate(25deg) scale(1.2)' } },
                aurora2: { '0%': { transform: 'translate(10%, 5%) rotate(0deg) scale(1.1)' }, '100%': { transform: 'translate(-15%, -10%) rotate(-20deg) scale(.9)' } },
                aurora3: { '0%': { transform: 'translate(0, 10%) scale(.9)' }, '100%': { transform: 'translate(10%, -15%) scale(1.15)' } },
                shine: { '0%': { backgroundPosition: '200% 50%' }, '100%': { backgroundPosition: '-200% 50%' } },
                float: { '0%, 100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-10px)' } },
                marquee: { '0%': { transform: 'translateX(0)' }, '100%': { transform: 'translateX(-50%)' } },
            },
        },
    },
    plugins: [],
}
