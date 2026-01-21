# KubeEZ Project Structure

```
kubeez/
├── frontend/                      # React + Vite Frontend
│   ├── public/                    # Static assets
│   ├── src/
│   │   ├── components/            # Reusable UI components
│   │   │   └── Header.jsx         # App header with branding
│   │   ├── pages/                 # Main application pages
│   │   │   ├── WizardFlow.jsx     # 4-step installation wizard
│   │   │   └── InstallationDashboard.jsx  # Real-time progress dashboard
│   │   ├── utils/                 # Utility functions
│   │   ├── App.jsx                # Main app component
│   │   ├── main.jsx               # React entry point
│   │   └── index.css              # Global styles + TailwindCSS
│   ├── index.html                 # HTML entry point
│   ├── package.json               # Frontend dependencies
│   ├── vite.config.js             # Vite configuration
│   ├── tailwind.config.js         # TailwindCSS configuration
│   └── postcss.config.js          # PostCSS configuration
│
├── backend/                       # Node.js + Express Backend
│   ├── src/
│   │   ├── routes/                # API route handlers
│   │   │   └── installation.js    # Cluster installation endpoints
│   │   ├── services/              # Business logic services
│   │   │   ├── installationManager.js  # Installation lifecycle management
│   │   │   └── automationEngine.js     # Kubernetes installation orchestration
│   │   ├── automation/            # Bash automation scripts
│   │   │   ├── preflight-checks.sh     # Pre-installation validation
│   │   │   ├── install-containerd.sh   # Container runtime installation
│   │   │   ├── install-kubernetes.sh   # K8s components installation
│   │   │   ├── init-control-plane.sh   # Control plane initialization
│   │   │   ├── install-network-plugin.sh  # CNI plugin installation
│   │   │   ├── join-worker.sh          # Worker node join script
│   │   │   └── install-addons.sh       # Add-ons installation
│   │   └── server.js              # Express server + WebSocket setup
│   ├── logs/                      # Installation logs (generated)
│   └── package.json               # Backend dependencies
│
├── package.json                   # Root package.json (runs both)
├── README.md                      # Project overview
└── SETUP.md                       # Detailed setup guide

```

## Key Files Explained

### Frontend

- **WizardFlow.jsx**: 4-step wizard for cluster configuration
  - Step 1: Cluster basics (name, version, CNI)
  - Step 2: Node configuration (master + worker nodes)
  - Step 3: Feature selection (add-ons)
  - Step 4: Review and install

- **InstallationDashboard.jsx**: Real-time installation monitoring
  - Progress tracking (0-100%)
  - Live log streaming via WebSocket
  - Status cards (progress, state, actions)
  - Kubeconfig download on completion

- **Header.jsx**: Application header with branding and navigation

- **index.css**: Global styles with:
  - TailwindCSS integration
  - Custom animations (gradients, pulses)
  - Glassmorphism effects
  - Terminal-style log display

### Backend

- **server.js**: Main Express server
  - REST API endpoints
  - WebSocket server for real-time updates
  - CORS configuration
  - Health check endpoint

- **installation.js**: API routes
  - POST /api/clusters/install - Start installation
  - GET /api/clusters/:id/status - Get status
  - GET /api/clusters/:id/logs - Get logs
  - POST /api/clusters/:id/cancel - Cancel installation

- **installationManager.js**: Core service
  - Manages installation lifecycle
  - Handles WebSocket broadcasting
  - Tracks progress and logs
  - Coordinates with automation engine

- **automationEngine.js**: Installation orchestration
  - Executes installation steps in sequence
  - Runs bash scripts via SSH
  - Provides callbacks for progress/logs
  - Handles errors and retries

### Automation Scripts

All scripts are production-ready and can be executed on target nodes:

1. **preflight-checks.sh**: Validates node requirements
2. **install-containerd.sh**: Installs container runtime
3. **install-kubernetes.sh**: Installs kubeadm, kubelet, kubectl
4. **init-control-plane.sh**: Initializes K8s control plane
5. **install-network-plugin.sh**: Installs Calico or Flannel
6. **join-worker.sh**: Joins worker nodes to cluster
7. **install-addons.sh**: Installs optional add-ons

## Technology Stack

### Frontend
- **React 18**: UI framework
- **Vite**: Build tool and dev server
- **TailwindCSS**: Utility-first CSS framework
- **Lucide React**: Beautiful icon library
- **WebSocket**: Real-time communication

### Backend
- **Node.js**: JavaScript runtime
- **Express**: Web framework
- **ws**: WebSocket library
- **node-ssh**: SSH client for remote execution
- **uuid**: Unique ID generation

### Automation
- **Bash**: Shell scripting
- **kubeadm**: Kubernetes cluster bootstrapping
- **containerd**: Container runtime
- **Calico/Flannel**: Network plugins

## Data Flow

```
User Input (Frontend)
    ↓
Wizard Form
    ↓
POST /api/clusters/install
    ↓
Installation Manager
    ↓
Automation Engine
    ↓
SSH to Target Nodes
    ↓
Execute Bash Scripts
    ↓
Stream Logs via WebSocket
    ↓
Update Frontend Dashboard
    ↓
Installation Complete
    ↓
Download Kubeconfig
```

## Development Workflow

1. **Start Development**:
   ```bash
   npm run dev  # Starts both frontend and backend
   ```

2. **Frontend Development**:
   - Edit files in `frontend/src/`
   - Hot reload enabled via Vite
   - Access at http://localhost:5173

3. **Backend Development**:
   - Edit files in `backend/src/`
   - Auto-restart enabled via `--watch` flag
   - Access at http://localhost:3000

4. **Testing Installation**:
   - Use the UI wizard to configure a cluster
   - Monitor real-time logs in the dashboard
   - Check backend logs in terminal

## Production Deployment

### Frontend
```bash
cd frontend
npm run build
# Deploy dist/ folder to static hosting (Netlify, Vercel, etc.)
```

### Backend
```bash
cd backend
npm start
# Deploy to Node.js hosting (Heroku, DigitalOcean, AWS, etc.)
```

### Environment Variables
```bash
# Backend
PORT=3000
NODE_ENV=production

# Frontend (build time)
VITE_API_URL=https://api.kubeez.io
```

## Next Steps

1. **Add Authentication**: Implement user login and multi-tenancy
2. **Database Integration**: Store cluster state in PostgreSQL
3. **Cluster Management**: Add upgrade, scaling, and deletion features
4. **Monitoring Integration**: Show cluster metrics in UI
5. **Multi-cluster Support**: Manage multiple clusters from one UI
6. **Air-gap Support**: Offline installation capability
7. **Custom Templates**: Pre-configured cluster templates
8. **Backup/Restore**: Automated cluster backup with Velero
