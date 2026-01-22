# 🤝 Contributing to KubeEZ

Thank you for your interest in contributing to KubeEZ! This document provides guidelines and instructions for contributing.

---

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Coding Standards](#coding-standards)

---

## 📜 Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Respect differing viewpoints and experiences

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm
- Docker and Docker Compose
- Git
- Basic knowledge of Kubernetes
- Familiarity with React and Express.js

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork:
```bash
git clone https://github.com/YOUR_USERNAME/Universal-K8s-Installer.git
cd Universal-K8s-Installer
```

3. Add upstream remote:
```bash
git remote add upstream https://github.com/ckmine11/Universal-K8s-Installer.git
```

---

## 💻 Development Setup

### Local Development

1. **Install dependencies:**
```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

2. **Start development servers:**
```bash
# Using Docker Compose (recommended)
docker-compose up -d --build

# Or run separately:
# Backend
cd backend
npm run dev

# Frontend
cd frontend
npm run dev
```

3. **Access the application:**
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000

---

## 📂 Project Structure

```
kubeez/
├── backend/
│   ├── src/
│   │   ├── automation/       # Bash scripts for K8s installation
│   │   ├── middleware/       # Express middleware
│   │   ├── routes/          # API route handlers
│   │   ├── services/        # Business logic
│   │   └── utils/           # Helper functions
│   ├── data/                # Persistent data storage
│   ├── logs/                # Application logs
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── components/      # Reusable React components
│   │   ├── pages/          # Page components
│   │   ├── services/       # API client services
│   │   └── utils/          # Helper functions
│   └── Dockerfile
├── docs/                    # Documentation
└── docker-compose.yml
```

---

## 🔧 Making Changes

### Branch Naming Convention

- `feature/` - New features (e.g., `feature/add-helm-support`)
- `fix/` - Bug fixes (e.g., `fix/ssh-connection-timeout`)
- `docs/` - Documentation updates (e.g., `docs/update-api-guide`)
- `refactor/` - Code refactoring (e.g., `refactor/cleanup-services`)
- `test/` - Adding tests (e.g., `test/add-unit-tests`)

### Create a Branch

```bash
git checkout -b feature/your-feature-name
```

### Commit Message Format

Follow conventional commits:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```bash
git commit -m "feat(monitoring): add Prometheus metrics endpoint"
git commit -m "fix(ssh): resolve connection timeout issue"
git commit -m "docs(api): update authentication examples"
```

---

## 🧪 Testing

### Running Tests

```bash
# Backend tests
cd backend
npm test

# Frontend tests
cd frontend
npm test

# Run specific test file
npm test -- path/to/test.js
```

### Writing Tests

- Place tests in `__tests__` directories
- Name test files with `.test.js` or `.spec.js` suffix
- Write descriptive test names
- Aim for good code coverage

**Example:**
```javascript
// backend/src/services/__tests__/backupService.test.js
import { BackupService } from '../backupService.js';

describe('BackupService', () => {
  test('should create backup successfully', async () => {
    const result = await BackupService.createBackup();
    expect(result.success).toBe(true);
  });
});
```

---

## 📤 Submitting Changes

### Before Submitting

1. **Update your branch:**
```bash
git fetch upstream
git rebase upstream/master
```

2. **Run tests:**
```bash
npm test
```

3. **Check code style:**
```bash
npm run lint
```

4. **Build successfully:**
```bash
docker-compose build
```

### Create Pull Request

1. Push your branch:
```bash
git push origin feature/your-feature-name
```

2. Go to GitHub and create a Pull Request

3. Fill in the PR template:
   - **Title:** Clear, descriptive title
   - **Description:** What changes were made and why
   - **Related Issues:** Link to related issues
   - **Testing:** How you tested the changes
   - **Screenshots:** If UI changes, include screenshots

### PR Review Process

- Maintainers will review your PR
- Address any feedback or requested changes
- Once approved, your PR will be merged

---

## 💎 Coding Standards

### JavaScript/Node.js

- Use ES6+ features
- Use `const` and `let`, avoid `var`
- Use async/await instead of callbacks
- Add JSDoc comments for functions
- Keep functions small and focused

**Example:**
```javascript
/**
 * Creates a backup of cluster data
 * @param {string} clusterId - The cluster ID to backup
 * @returns {Promise<Object>} Backup result
 */
async function createBackup(clusterId) {
  // Implementation
}
```

### React

- Use functional components with hooks
- Keep components small and reusable
- Use meaningful component and prop names
- Add PropTypes or TypeScript types

**Example:**
```javascript
import React, { useState, useEffect } from 'react';

export function ClusterCard({ cluster, onSelect }) {
  const [status, setStatus] = useState('loading');
  
  useEffect(() => {
    // Fetch cluster status
  }, [cluster.id]);
  
  return (
    <div className="cluster-card">
      {/* Component JSX */}
    </div>
  );
}
```

### Bash Scripts

- Add shebang: `#!/bin/bash`
- Use `set -e` for error handling
- Add comments for complex logic
- Use meaningful variable names
- Quote variables: `"$VARIABLE"`

**Example:**
```bash
#!/bin/bash
set -e

CLUSTER_NAME=${1:-"default"}

echo "Installing cluster: $CLUSTER_NAME"
# Implementation
```

### CSS

- Use meaningful class names
- Follow BEM naming convention when appropriate
- Keep selectors simple
- Use CSS variables for theming

---

## 🎯 Areas for Contribution

### High Priority

- [ ] Add unit and integration tests
- [ ] Improve error handling and logging
- [ ] Add support for more Linux distributions
- [ ] Enhance monitoring dashboards
- [ ] Add cluster upgrade automation

### Medium Priority

- [ ] Add more add-ons (cert-manager, ArgoCD, etc.)
- [ ] Improve UI/UX
- [ ] Add multi-cluster management
- [ ] Create CLI tool
- [ ] Add backup/restore functionality

### Documentation

- [ ] Add video tutorials
- [ ] Improve API documentation
- [ ] Create architecture diagrams
- [ ] Write blog posts/use cases
- [ ] Translate documentation

---

## 🐛 Reporting Bugs

### Before Reporting

1. Check existing issues
2. Try the latest version
3. Review troubleshooting guide

### Bug Report Template

```markdown
**Describe the bug**
A clear description of what the bug is.

**To Reproduce**
Steps to reproduce:
1. Go to '...'
2. Click on '...'
3. See error

**Expected behavior**
What you expected to happen.

**Screenshots**
If applicable, add screenshots.

**Environment:**
- OS: [e.g., Ubuntu 22.04]
- Docker version:
- KubeEZ version:
- Browser: [if frontend issue]

**Logs**
```
Paste relevant logs here
```

**Additional context**
Any other context about the problem.
```

---

## 💡 Feature Requests

We welcome feature requests! Please:

1. Check if the feature already exists or is planned
2. Clearly describe the feature and use case
3. Explain why it would be valuable
4. Consider contributing the implementation

---

## 📞 Getting Help

- **GitHub Discussions:** Ask questions and discuss ideas
- **GitHub Issues:** Report bugs and request features
- **Documentation:** Check existing docs first

---

## 🏆 Recognition

Contributors will be:
- Listed in CONTRIBUTORS.md
- Mentioned in release notes
- Credited in documentation

---

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing to KubeEZ!** 🚀
