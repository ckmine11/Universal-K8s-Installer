# Changelog

All notable changes to KubeEZ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed — sidebar badges
- Security and Certificates badges count only what you have not seen yet: opening the tab clears them; a new critical CVE, or a certificate getting worse, brings them back. Per person, kept on the server.

### Changed — plans
- **Free runs one cluster for real:** 1 cluster, **5 nodes** (was 2 — a typical 3-node cluster could not even be added), 1 member. Registries, new GitOps apps, debug containers and Helm drift moved to Free; so did the add-ons Free features need (Explorer, Ingress, cert-manager, Trivy, Argo CD, Flux).
- **14-day Pro trial** for every new hosted workspace (`KUBEEZ_TRIAL_DAYS`, 0 = off): every feature and Pro limits; Free afterwards, nothing deleted. Its last 3 days and its end are shown in a banner (what gets locked, any Free limit the workspace is over) and in the top bar ("Trial ended · Upgrade").
- **Plan & usage** page: your plan, trial days left, usage against limits, and every feature and paid capability with ✓ or 🔒 Pro (`GET /api/billing/plan`). The top bar shows "Pro trial · N days left" / "Free · Upgrade".
- On Free, the deploy preview names images with critical vulnerabilities the Pro CVE gate would stop, and Certificates says Pro would have alerted.
- Plan numbers live in one place (`services/plans.js`); the nightly config backup now follows the workspace plan (it read the owner's stored plan).

### Fixed
- **Delivery settings**: the Cluster lists (environments, freezes, deploy tokens, registries) were empty — the page asked a route that does not exist.
- **Chart lists of large repositories** (Bitnami: 28 MB index) took ~900 MB and blocked the server for ~10 s, so a 512 MB container restarted. Only the newest 30 versions of each chart are read now (~110 MB, the server stays responsive); two requests for the same repository share one read.
- **Helm on RHEL-family nodes**: `sudo` did not find a Helm installed in `/usr/local/bin` ("sudo: helm: command not found"), breaking Apps, Compare, Previews and Drift; KubeEZ now runs it by its full path.
- **A new sign-in on the same browser showed the previous person's Ask AI conversation** (and last cluster, installations). The browser now forgets them when someone else signs in or anyone signs out.
- **Free workspaces**: pages loaded Pro lists by themselves, so Delivery settings failed to load and an upgrade pop-up appeared without a click. Pro sections now show a "Pro — Upgrade" card on Free and load nothing; Pro buttons still ask to upgrade when clicked.
- **AI "No AI engine could answer right now"** hid the reason. It now says why in the engine's own words (e.g. OpenRouter: free-models-per-day used up) and where to fix it; a daily quota is no longer retried, the engine is paused with that reason.
- **Helm 4** (which KubeEZ installs) has no `helm list -a`: listing releases failed ("unknown shorthand flag: 'a'"), so Apps, Compare and Previews showed nothing, and uninstalling an add-on left its releases behind. Helm 3 and 4 both work now.

### Added
- Sidebar: every page once, a cluster switcher, folding groups, and count badges on Security and Certificates.

## [2.3.0] - 2026-11-02

Everything since 2.2.0 (about 250 changes). The built-in guide (Help → Docs) describes each feature.

### Added — shipping apps
- **Helm apps** per cluster: install / upgrade from the workspace's chart repositories with a server-side dry-run diff, roll back to any revision, values with secrets masked.
- **Delivery settings**: environments (protected = a second person for every deploy), chart repositories, change freezes (admin override with a reason), compare environments, **promotion pipeline**, **auto-rollback** of deploys that break their workload, registry pull secrets, cost prices.
- **Deploy tokens and CI webhook** (`POST /api/hooks/deploy`): one release per token, only the listed values; an optional commit gives the DORA **lead time for changes**.
- **Preview environments** per pull request or branch (UI and `POST/DELETE /api/hooks/preview`), removed by themselves when they expire.
- **Deploy from chat** (Slack / Telegram ChatOps): `deploy web 1.4.2 to staging`, confirmed with a code by the same person; only apps an admin allowed for that channel.
- **Deploy guards** on every deploy path: a **CVE gate** (Trivy reports) and an **image signature gate** (cosign, verified in the registry against the workspace's signing keys), warn or block.
- **Deploy risk**: a 0–100 score from the diff, the release history and open problems, explained by the connected AI.
- **Helm drift**: what was changed by hand, compared with `kubectl diff` against the deployed manifest; restore in one click; hourly alerts.

### Added — GitOps
- Argo CD and Flux apps on one list with sync, health and drift; **Sync now** / **Refresh**; alerts; **Explain with AI**.
- New **Argo CD apps** (own AppProject) and **Flux apps** (own namespace-only ServiceAccount), locked to one namespace, never pruned.
- **Promotions by pull request** on **GitHub, GitLab** (merge requests, sub-groups) **and Bitbucket**.

### Added — security & insight
- **Security** tab (Trivy Operator): vulnerabilities and misconfigurations per workload; alerts for new fixable critical CVEs; critical CVEs in the risk score; External Secrets status.
- **Certificates** tab (cert-manager): certificates by state and expiry, issuers, stuck ACME challenges, **Renew now** (`cert:renew`), alerts at 14 / 7 / 3 / 1 days.
- **Delivery** tab: DORA metrics (deployment frequency, change failure rate, recovery time, lead time).
- App metrics from Prometheus, **cost per app**, Hibernate / Wake (also on a schedule), debug containers, Argo Rollouts canaries, KEDA autoscaling wizard.
- Add-ons: External Secrets, Argo Rollouts, KEDA (30 add-ons in all).

### Added — platform
- **KubeEZ AI**: Ask AI from live cluster data in English / Hindi / Hinglish, bring your own AI (OpenRouter sign-in, cloud keys, or offline Ollama / vLLM / LM Studio), Install Doctor, incident explanations with dry-run fixes and undo, Create YAML, Fleet, Advisor, What changed, ChatOps in Slack and Telegram, MCP server, quality tests and model comparison, usage and budgets.
- **Connect existing clusters** (EKS, AKS, GKE, OKE, DOKS, LKE, k3s, RKE2, OpenShift…): KubeEZ agent, connect command or kubeconfig; read-only or full manage; node pools and upgrades through the cloud account; SSH for on-prem.
- **Team**: custom roles, per-cluster / per-label / per-namespace access, two-person approvals, temporary access, access review; sign-in with Google / GitHub and **SSO with any OpenID Connect provider** (`OIDC_*`).
- **Feature flags** (server-wide `KUBEEZ_FEATURES` and per workspace on the Features page) and **plan gating**: Free sees every feature, Pro and Enterprise include all of them.
- Compliance Center (CERT-In, DPDP, ISO 27001, CIS) with a tamper-evident audit trail; auto-healing 2.0; alert routing and escalation; safe etcd restore, disaster recovery and volume backups; KubeEZ Explorer; node shells; new themes.

### Changed
- Version numbers aligned: backend, frontend and `/api/config` report 2.3.0.
- Removing a GitOps app KubeEZ created now deletes everything it deployed too (Argo CD resources finalizer / Flux prune), so nothing is left to clean up by hand; "keep running" stays available.
- `.env.example` documents SSO (`OIDC_*`) and feature flags.
- Documentation rewritten in English for this version: README, SETUP, USER_GUIDE, FEATURES_EXPLAINED, TESTING_GUIDE, UI guide (UI_ENHANCEMENTS), engineering notes (IMPROVEMENTS), API (CI and ChatOps), and the in-app Docs.
- The Gateway Agent page's "connected" message is in English (it was Roman Hindi since 2.2.0).
- All other guides rewritten for this version: DEPLOY, DOCKER_GUIDE, DOCKER_QUICKSTART, REAL_INSTALLATION_GUIDE, SUDO_SETUP, MULTI_SITE_SETUP (host nginx now passes WebSockets for the Explorer and terminals), LICENSING_GUIDE, TROUBLESHOOTING, CLOUDFLARE_SETUP (Tunnel or proxied DNS) and CONTRIBUTING.

### Fixed
- `docker-compose.prod.yml` now passes `OIDC_*`, `KUBEEZ_FEATURES*`, `KUBEEZ_ALLOW_PRIVATE_SSH`, `ALERT_EMAILS_PER_DAY_*` and `AUDIT_RETENTION_DAYS` from `.env` to the backend — before, those settings had no effect in Docker.
- `docker-compose.yml` (development) takes `KUBEEZ_MODE` and `APP_SECRET` from `.env` instead of always running in SaaS mode.
- **Self-hosted licenses now set the plan.** An active license gives every workspace on the server its plan (Enterprise for `ENTERPRISE…` licenses, Pro for any other) — features including their background checks, backups, compliance reports, custom roles, approvals and alert channels — and its team seats (`maxMembers`, or no limit). Before, a license only raised the cluster and node limits, so Pro features worked only for the platform owner and Pro background checks never ran. Expired, foreign-signed or other-server licenses fall back to Free at once.
- License generator and vendor portal (a "Team seats per workspace" field) accept an optional seat count (`maxMembers`); the team page shows "∞" when there is no limit.

### Not yet verified
- Features added on 2026-10-30 and later are covered by automated tests with simulated clusters, registries and Git providers; they have not been run against real clusters yet.

---

## [2.2.0] - 2026-06-19

### Added
- 🚀 **Zero-Install Gateway Agent**: The agent script now automatically bundles its dependencies into a single `agent-bundle.js` using `esbuild`.
- 💻 **Portable Node.js Auto-Download**: The PowerShell/Bash installation script now automatically downloads a portable Node.js v18.20.2 binary if Node is not installed on the system. No manual Node.js installation required!
- 🔄 **Agent Refresh Button**: Added a manual refresh button to the Registered Agents UI to quickly poll agent online status.

### Changed
- 🌐 **Localized Gateway UI**: Translated Gateway Agent connection instructions into easy-to-understand Roman Hindi to improve user comprehension.
- 🎨 **Simplified Settings**: Removed the "System Health" monitoring tab from the Settings page to keep the admin interface clean and focused strictly on cluster management.
- 🧹 **UI Cleanups**: Removed unnecessary dummy data, GitHub links, and "Engineered by" footers to provide a premium SaaS look.
- ⚙️ **Nginx Proxy Updates**: Updated the Nginx proxy rules to properly route requests for the newly bundled `agent-bundle.js`.

---

## [2.1.0] - 2026-01-22

### Added
- 📚 Comprehensive API documentation (API.md)
- 🔧 Detailed troubleshooting guide (TROUBLESHOOTING.md)
- 🤝 Contributing guidelines (CONTRIBUTING.md)
- 📝 Changelog for version tracking
- 🔄 Backup service for cluster data
- 📊 Enhanced health check endpoints with detailed metrics
- 🛡️ Rate limiting middleware for API protection
- 📋 Request logging middleware
- 🎨 Toast notification system for better UX
- 🧪 Test infrastructure setup
- ⚙️ Additional Kubernetes add-ons support

### Fixed
- 🐛 Resolved all bugs in install-addons.sh script
- ✅ Added missing Prometheus NodePort service (port 30090)
- 🔢 Fixed step numbering in monitoring installation (1/5 through 5/5)
- ⏳ Added proper wait conditions for Prometheus readiness
- 🔒 Improved error handling with proper exit codes
- 🧹 Added cleanup trap for temporary files
- 📌 Pinned Grafana version to 10.2.3 (removed 'latest' tag)

### Changed
- 📦 Added resource limits for all deployments:
  - Prometheus: 400Mi-800Mi memory, 200m-500m CPU
  - Grafana: 128Mi-256Mi memory, 100m-200m CPU
  - Node Exporter: 64Mi-128Mi memory, 50m-100m CPU
  - Kube-State-Metrics: 128Mi-256Mi memory, 100m-200m CPU
- 🔐 Enhanced dashboard security with dual user roles (viewer + admin)
- 📖 Improved installation documentation

### Removed
- ❌ Incomplete logging add-on (replaced with helpful error message)

---

## [2.0.0] - 2026-01-20

### Added
- 🧠 Intelligent Self-Healing Engine
- 🔍 Smart diagnostics for common installation failures
- 🛠️ Auto-fix actions for DNS, package locks, swap, and Kubernetes resets
- 🎨 Glassmorphism UI with dark mode
- 📊 Live node monitoring with real-time metrics
- 🔌 WebSocket support for real-time updates
- 🔐 JWT authentication for API endpoints
- 📦 Add-on installation system (Ingress, Monitoring, Dashboard)
- 🌐 Multi-OS support (Ubuntu, CentOS, RHEL, Rocky Linux)
- 🎯 Wizard-based installation flow
- 💾 Persistent cluster state management
- 🔄 Automatic retry mechanism with recovery

### Changed
- Migrated from polling to WebSocket for real-time updates
- Improved error handling and user feedback
- Enhanced SSH connection management
- Optimized installation scripts for reliability

---

## [1.0.0] - 2026-01-15

### Added
- 🚀 Initial release of KubeEZ
- 📝 Basic Kubernetes cluster installation
- 🖥️ Simple web-based UI
- 🔧 SSH-based node management
- 📊 Basic cluster status monitoring
- 🐳 Docker Compose deployment
- 📖 Initial documentation (README, SETUP, DEPLOY guides)

---

## [Unreleased]

### Planned Features
- 🔄 Cluster upgrade automation
- 🌍 Multi-cloud support (AWS EKS, Azure AKS, GCP GKE)
- 🔌 Plugin system for extensibility
- 📊 Advanced analytics dashboard
- 🤖 AI-powered recommendations
- 💾 Backup and disaster recovery
- 🔐 Enhanced security features
- 📱 Mobile-responsive UI improvements
- 🧪 Comprehensive test coverage
- 🛠️ CLI tool for power users

---

## Version History

| Version | Release Date | Highlights |
|---------|-------------|------------|
| 2.2.0   | 2026-06-19  | Zero-Install Gateway Agent, UI cleanups |
| 2.1.0   | 2026-01-22  | Bug fixes, documentation, monitoring improvements |
| 2.0.0   | 2026-01-20  | Self-healing engine, WebSocket support |
| 1.0.0   | 2026-01-15  | Initial release |

---

## Migration Guides

### Upgrading from 2.0.0 to 2.1.0

No breaking changes. Simply pull the latest code and rebuild:

```bash
git pull origin master
docker-compose down
docker-compose up -d --build
```

**New Features Available:**
- Access enhanced health check at `/api/health/detailed`
- Check new API documentation in API.md
- Use troubleshooting guide for common issues

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details on how to contribute to KubeEZ.

---

## Links

- [GitHub Repository](https://github.com/ckmine11/Universal-K8s-Installer)
- [Issue Tracker](https://github.com/ckmine11/Universal-K8s-Installer/issues)
- [Documentation](./README.md)
