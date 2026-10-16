/** @type {import('tailwindcss').Config} */

// KubeEZ "Obsidian Iris" theme.
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
    50: '#f7f7f9',
    100: '#ededf1',
    200: '#dadae1',
    300: '#babac6',
    400: '#90909f',
    500: '#6d6d7b',
    600: '#51515d',
    700: '#3a3a44',
    800: '#25252d',
    900: '#16161b',
    950: '#0b0b0f',
}

export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                blue: iris,
                slate: graphite,
                iris,
                graphite,
                // older names, kept so nothing breaks
                aurora: iris,
                night: graphite,
                // tokens used by the Lightswind components
                primary: { ...iris, DEFAULT: iris[500], foreground: '#ffffff' },
                primarylw: iris[500],
                secondary: { DEFAULT: graphite[400], foreground: graphite[100] },
                foreground: graphite[100],
                background: '#08080b',
                k8s: {
                    blue: '#326CE5',
                    lightblue: '#4A90E2',
                    dark: '#0F1419',
                }
            },
            fontFamily: {
                sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
                display: ['Geist', 'Inter', 'sans-serif'],
                serif: ['"Instrument Serif"', 'Georgia', 'serif'],
                mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
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
