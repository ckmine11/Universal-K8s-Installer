# Engineering Notes — Safety, Reliability and Known Gaps

*Version 2.3.0 · November 2026.* How KubeEZ is built to be safe to run against production clusters, and what is still missing. For features see [README.md](README.md); for changes, [CHANGELOG.md](CHANGELOG.md).

---

## 1. Principles

1. **Explain, don't stack-trace.** Scripts print machine-readable lines (`KUBEEZ_FAIL|code|reason|fix`, `KUBEEZ_PROGRESS|…`) that the console turns into a reason and a fix.
2. **Preview before change.** Add-on settings, Helm deploys, etcd restores and AI fixes show what will change (a dry run or a diff) before anything runs.
3. **Undo is part of the change.** Failed add-on changes and Helm upgrades roll back by themselves; etcd restores can be undone; AI fixes record their undo.
4. **Ask the tool to do its own job.** GitOps sync uses Argo CD's operation / Flux's reconcile annotation; certificate renewal uses cert-manager's Issuing condition; KubeEZ never edits an app's spec or prunes.
5. **Never read what you don't need.** KubeEZ never reads Kubernetes Secrets for its views (GitOps, Trivy, cert-manager, drift); Secret values in Helm diffs are hashed.
6. **Least privilege everywhere.** A deploy token deploys one release; a chat channel deploys only the apps an admin allowed; a Flux app runs as a ServiceAccount that may only change its namespace; an Argo CD app gets its own AppProject.

---

## 2. Access control

- **Roles** are enforced by the API (`backend/src/config/permissions.js`, mirrored in the frontend only for display). Every route checks the role, the cluster rule (per cluster or label) and namespace limits.
- **Two-person approval** (`services/approvals.js`): protected actions return `428` until a second person approves that exact request (method, path and body hash), once.
- **Protected environments** always need approval for deploy, rollback, uninstall and promotion.
- **Change freezes** return `423`; only admins may override, with a reason that is recorded.
- **Feature flags** (`services/features.js`): a feature can be off on the server or for a workspace (`403 FEATURE_OFF`); a plan that lacks it answers `402 UPGRADE_REQUIRED`. Background work stops when a feature is off.
- **Audit trail** (`services/auditLog.js`): monthly JSONL files chained with SHA-256, so edits are detectable; kept 400 days.

## 3. Secrets and credentials

- Node passwords, SSH keys, bot tokens, webhook URLs, chart-repository and registry passwords, Git tokens, cloud credentials and AI keys are **encrypted at rest** with `APP_SECRET` and never sent back to the browser.
- Deploy tokens (`kzt_…`) are shown once and stored as a SHA-256 hash, with an expiry and revocation.
- Helm values that look like secrets are masked (`••••••`); sending the mask back keeps the real value.
- Text sent to an AI engine is redacted (secrets, optionally emails and IPs) and wrapped as untrusted data, with prompt-injection detection.

## 4. Network safety

- In SaaS mode the server never opens SSH, webhooks, Git API, registry or S3 connections to **private or internal addresses** (`utils/netGuard.js`); private servers are reached only through their own Gateway Agent.
- Registry downloads follow redirects one hop at a time, each checked, and drop credentials when leaving the registry (blob CDNs).
- Sessions are httpOnly cookies; a password change ends other sessions; login lockout; CORS limited to the site and `ALLOWED_ORIGINS`.
- Slack ChatOps requests must carry Slack's signature (checked on the raw body, 5-minute window). Chat deploys need a confirmation code from the same person.

## 5. Cluster commands

- Every value that reaches a shell is validated against a strict pattern (names, namespaces, versions, paths) **and** single-quoted.
- Commands for connected clusters run on the KubeEZ server in a per-cluster sandbox: its own user, no access to KubeEZ's files, only `kubectl` and `helm`.
- Long jobs (installs, upgrades, Helm deploys) run in the background with polling, so a proxy timeout (Cloudflare's 100 s) never cuts them off.
- One running job per release / cluster; a second one is refused with `409`.

## 6. Data

- State is kept in JSON files under `backend/data`, written atomically (`utils/atomicWrite.js`).
- KubeEZ backs up its own data daily.
- Preview environments are tracked by a namespace label (`kubeez.io/preview=<id>`); KubeEZ deletes only namespaces that carry its own label.

## 7. Testing

About 750 backend tests (`node:test`) cover the API gates for every role, auto-healing, backups, AI safety and the delivery features, using in-process servers and fake cluster connections. End-to-end runs install real clusters on 7 Linux distributions in Docker. See [TESTING_GUIDE.md](TESTING_GUIDE.md).

---

## 8. Known gaps

| Gap | Impact | Direction |
|---|---|---|
| **Not yet run on real clusters:** features from 2026-10-30 on (GitOps actions, Helm apps, delivery, previews, chat deploy, signature gate, drift, certificates) | Bugs that simulated clusters, registries and Git providers cannot show | Run each against a real cluster, real registries and real GitHub / GitLab / Bitbucket accounts |
| **JSON-file storage** | One backend instance per installation; no horizontal scaling | A database (PostgreSQL) |
| **No Content-Security-Policy header** | Less defence in depth against XSS | Enable CSP once the frontend's needs are mapped |
| **No frontend tests or linter** | UI regressions are caught only by building and manual checks | Component tests and ESLint |
| **Cosign: key-based only** | No keyless (Fulcio) signatures, no Rekor transparency-log check | Add keyless verification |
| **Bitbucket: Cloud only** | Bitbucket Server / Data Center promotions are not supported | A Server adapter |
| **Helm drift scope** | Only fields the chart sets count; fields added by hand outside the chart are not shown; up to 40 releases per check | Accept, or add a three-way comparison |
| **Gateway Agent bundles Node 18** | Node 18 is end-of-life | Move the portable runtime to Node 22 |
| **Older docs** | Some guides in the repository (e.g. DEPLOY.md, DOCKER_GUIDE.md) predate 2.3.0 | Keep README, SETUP, USER_GUIDE and the in-app Docs as the reference |
