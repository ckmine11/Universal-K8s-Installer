/** @type {import('tailwindcss').Config} */

// KubeEZ "Aurora Glass" theme.
// The whole app is built with Tailwind's colour names, so the theme remaps
// them in one place: `blue` becomes the aurora cyan (the brand colour),
// `slate` becomes a cool night-navy grey. Violet/purple stays the second
// aurora colour; emerald/amber/red keep meaning success/warning/danger.
const aurora = {
    50: '#ecfdff',
    100: '#cff7fe',
    200: '#a5eefc',
    300: '#67e0f9',
    400: '#2ccbee',
    500: '#0fb0dc',
    600: '#0784ad',
    700: '#0d6a8f',
    800: '#135775',
    900: '#154862',
    950: '#072d40',
}
const night = {
    50: '#f6f8fc',
    100: '#edf1f8',
    200: '#d9e0ec',
    300: '#b6c1d6',
    400: '#8794ae',
    500: '#646f8a',
    600: '#4a556d',
    700: '#343d52',
    800: '#1f2638',
    900: '#121828',
    950: '#090d18',
}

export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                blue: aurora,
                slate: night,
                aurora,
                night,
                primary: aurora,
                k8s: {
                    blue: '#326CE5',
                    lightblue: '#4A90E2',
                    dark: '#0F1419',
                }
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', 'sans-serif'],
                display: ['Sora', 'Inter', 'sans-serif'],
                mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
            },
            boxShadow: {
                glow: '0 0 0 1px rgba(44,203,238,.25), 0 8px 40px -8px rgba(44,203,238,.35)',
                'glow-violet': '0 0 0 1px rgba(139,92,246,.25), 0 8px 40px -8px rgba(139,92,246,.35)',
                glass: 'inset 0 1px 0 0 rgba(255,255,255,.06), 0 20px 50px -20px rgba(0,0,0,.6)',
            },
            backgroundImage: {
                'aurora-gradient': 'linear-gradient(135deg, #2ccbee 0%, #6d7cff 50%, #a855f7 100%)',
            },
            animation: {
                'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
                'spin-slow': 'spin 3s linear infinite',
                'aurora-1': 'aurora1 28s ease-in-out infinite alternate',
                'aurora-2': 'aurora2 34s ease-in-out infinite alternate',
                'aurora-3': 'aurora3 40s ease-in-out infinite alternate',
            },
            keyframes: {
                aurora1: { '0%': { transform: 'translate(-10%, -10%) rotate(0deg) scale(1)' }, '100%': { transform: 'translate(15%, 10%) rotate(25deg) scale(1.2)' } },
                aurora2: { '0%': { transform: 'translate(10%, 5%) rotate(0deg) scale(1.1)' }, '100%': { transform: 'translate(-15%, -10%) rotate(-20deg) scale(.9)' } },
                aurora3: { '0%': { transform: 'translate(0, 10%) scale(.9)' }, '100%': { transform: 'translate(10%, -15%) scale(1.15)' } },
            },
        },
    },
    plugins: [],
}
