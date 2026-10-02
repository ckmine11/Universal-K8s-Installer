# Backend tests

Uses Node's built-in test runner — no extra dependencies.

```bash
npm install
npm test                 # all *.test.js files
node --test tests/services.test.js
```

- `api-security.test.js` boots the real server (`helpers/server.js`) on a random
  port with a throw-away data directory (`KUBEEZ_DATA_DIR`), so tests never
  touch `backend/data`.
- `services.test.js` imports services in-process; it sets `KUBEEZ_DATA_DIR`
  before importing them.

See `../../tests/README.md` for the upgrade-script and end-to-end suites.
