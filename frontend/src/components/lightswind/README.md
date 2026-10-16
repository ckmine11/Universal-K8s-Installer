Components from Lightswind UI (https://lightswind.com, MIT License),
installed as source with `npx lightswind@latest add <name>` and adapted:
- globe.tsx — needs cobe 0.6 (cobe 2 changed its API); wheel zoom is turned off where it is used
- border-beam, count-up, shiny-text are unchanged

They use `cn()` from src/lib/utils.ts and the `@/` alias (vite.config.js).
