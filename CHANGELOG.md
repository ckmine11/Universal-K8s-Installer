# Changelog

All notable changes to KubeEZ will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
