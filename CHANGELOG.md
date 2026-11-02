# Changelog

All notable changes to KubeEZ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
- `.env.example` documents SSO (`OIDC_*`) and feature flags.
- Documentation rewritten in English for this version: README, SETUP, USER_GUIDE, FEATURES_EXPLAINED, TESTING_GUIDE, UI guide (UI_ENHANCEMENTS), engineering notes (IMPROVEMENTS), API (CI and ChatOps), and the in-app Docs.
- The Gateway Agent page's "connected" message is in English (it was Roman Hindi since 2.2.0).

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
