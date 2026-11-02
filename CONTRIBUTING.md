# Contributing to KubeEZ

*Version 2.3.0 · November 2026.* How to set up the code, the conventions the codebase follows, and what a change needs before it is merged.

Be respectful and constructive in issues and reviews. **Never post a vulnerability publicly** — report it privately to the maintainers.

---

## 1. Set up

Requirements: **Node.js 20+** (22 recommended), **Docker** (for the full stack and end-to-end tests), Git.

```bash
git clone https://github.com/<you>/Universal-K8s-Installer.git
cd Universal-K8s-Installer
cp .env.example .env

# everything in Docker: console :5173, API :3000
docker compose up -d --build

# or each part with hot reload
cd backend  && npm install && npm run dev     # API on :3000
cd frontend && npm install && npm run dev     # console on :5173, /api proxied to :3000
```

Set `KUBEEZ_MODE=selfhosted` in `.env` to get the first-admin screen on a fresh data folder; in SaaS mode create the platform owner with `node scripts/make-superadmin.js <user> <password> <email>` (in `backend/`). Your local data lives in `backend/data` — never commit it.

---

## 2. Where things are

| Path | What |
|---|---|
| `backend/src/server.js` | Express app, middleware order, route mounting, background loops |
| `backend/src/routes/` | REST API — one file per area |
| `backend/src/services/` | the logic: cluster access, automation, healing, AI (`ai/`), Helm apps, GitOps, delivery, security… |
| `backend/src/config/permissions.js` | roles → permissions (the API enforces it; `frontend/src/config/permissions.js` mirrors it for display) |
| `backend/src/services/features.js` | feature flags and which plan includes each |
| `backend/src/automation/` | Bash scripts run on cluster nodes |
| `backend/tests/` | `node:test` suites |
| `frontend/src/pages/`, `components/` | React console (Vite + Tailwind) |
| `frontend/src/pages/Docs.jsx` | the in-app user guide |
| `tests/e2e/` | end-to-end runs on real distros in Docker |

Module maps and design notes: [IMPROVEMENTS.md](IMPROVEMENTS.md), [UI_ENHANCEMENTS.md](UI_ENHANCEMENTS.md), [TESTING_GUIDE.md](TESTING_GUIDE.md).

---

## 3. Conventions

### Backend (Node.js, ES modules)
- Match the surrounding code: small functions, the comment density and naming of the file you are in. Each service starts with a comment saying what it does and why.
- **Validate every input** with a strict pattern before it reaches a shell, a file path or a URL; quote shell values with the file's `q()` helper. Reject `__proto__` / `constructor` / `prototype` in value paths.
- **Every route checks access**: `requirePermission(...)`, the cluster rule (`canSeeCluster`, `canOn`) and namespace limits; a cluster or namespace the member may not see answers **404**.
- New features get a **feature flag** in `services/features.js` (`plan: 'free'` or `'pro'` — never Enterprise-only) and `requireFeature(...)` on their routes.
- Changes go through the existing gates where they apply: two-person approval (`requireApproval`), change freezes (`checkFreeze`), protected environments, the CVE and signature gates.
- Set `req.auditDetail` so the audit trail says what happened.
- Secrets are encrypted with `utils/cryptoUtils.js` and never sent to the browser; values in API answers are masked.
- In SaaS mode, outbound connections go through `assertDirectConnectAllowed` (no private / internal addresses).
- Services that run commands expose `_test.useConnect(fn)`; services that call outside APIs take a `fetchImpl` — so they can be tested without a cluster.
- Errors carry an HTTP `status` and a message a person can act on ("what happened — what to do").

### Frontend (React + Tailwind)
- Function components and hooks; call the API with `apiFetch` and show the server's error message.
- Use the shared classes (`kz-card`, `kz-input`, `kz-btn-primary`, `kz-btn-ghost`) and `lucide-react` icons.
- Hide what a member may not use (`can(role, …)`, `useFeatures()`), but never rely on that for security — the API decides.
- Icon-only buttons need an `aria-label`; never show state by colour alone.
- Preview before change, confirm the irreversible, mask secrets — see [UI_ENHANCEMENTS.md](UI_ENHANCEMENTS.md).

### Bash (node scripts)
- `#!/bin/bash`, `set -e` where safe, quoted variables, idempotent steps (re-running must be safe).
- Report failures as `KUBEEZ_FAIL|CODE|reason|fix` and progress as `KUBEEZ_PROGRESS|…` so the console can explain them.
- Support every listed distro (apt and dnf / yum paths).

### Docs and language
- Everything — UI text, docs, commit messages — in clear English.
- A user-visible change updates the in-app guide (`Docs.jsx`) and, where relevant, [USER_GUIDE.md](USER_GUIDE.md), [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md).

---

## 4. Tests

```bash
cd backend && npm test                 # must stay green (~750 tests)
cd frontend && npm run build           # must build (there are no frontend unit tests yet)
bash -n backend/src/automation/<script>.sh
```

A new feature's tests cover: input checks (400), every role and a namespace-limited member (200 / 403 / 404), the gates (feature off 403, plan 402, approval 428, freeze 423, read-only cluster 409), the exact commands sent to the cluster, and the audit entry. How-to and examples: [TESTING_GUIDE.md](TESTING_GUIDE.md). Changes to install, upgrade or backup scripts should also pass the matching end-to-end scenario (`bash tests/e2e/e2e.sh <scenario> <distro>`).

---

## 5. Commits and pull requests

- Branch from `master`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`.
- Commit messages in the style of the history — a type, an optional scope, and what changed for the user:
  ```
  feat: preview environments per pull request
  fix(explorer): a 502 says who answered it and why
  docs: rewrite the setup guide for 2.3.0
  ```
- One topic per pull request. Describe what changed, why, and how you tested it (including anything not tested on a real cluster).
- CI must pass: script syntax, backend tests, frontend build, and the install / upgrade jobs that apply.

---

## 6. Where help is welcome

- Running the newer features (GitOps actions, Helm apps, delivery, previews, chat deploy, signature gate, drift, certificates) against **real clusters** and reporting what breaks.
- Frontend tests and a linter.
- A database store (PostgreSQL) instead of JSON files.
- A Content-Security-Policy for the console.
- Keyless (Fulcio / Rekor) cosign verification; Bitbucket Server; a newer Node.js runtime for the Gateway Agent.
