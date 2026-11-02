# 📡 KubeEZ API Documentation

> **v2.3.0 (2026-11-02).** The console uses the REST API under `/api` with an httpOnly session cookie (an `Authorization: Bearer <token>` header also works). Every route checks the member's role, cluster and namespace access, the workspace's feature flags (403 `FEATURE_OFF`), its plan (402 `UPGRADE_REQUIRED`), two-person approval (428) and change freezes (423). The endpoint list further below is from an older version; the public endpoints for CI and chat are documented here.

## Deploy from CI — `/api/hooks` (a deploy token, no session)

Create a token under **Delivery → Deploy tokens** (admins, Pro). A token deploys one release (cluster, namespace, chart, repository) and may change only the values it lists.

| Method & path | Body | What it does |
|---|---|---|
| `POST /api/hooks/deploy` | `{ "set": { "image.tag": "1.4.2" }, "version"?: "1.5.0", "commit"?: { "sha": "…", "time": "ISO date" } }` | Upgrades the token's release with the live values plus `set`. A `commit` counts for the DORA lead time once the deploy succeeds. → `202` and the job. |
| `GET /api/hooks/jobs/:id` | — | The job: `running`, `done` or `failed` (with `error`, `warnings`, `cve`, `signatures`). |
| `POST /api/hooks/preview` | `{ "pr": 42 } or { "branch": "feature/login" }, "set"?, "ttlHours"?: 1–336` | A preview environment (token made with "previews"): a copy of the token's release in `<release>-pr-42`. → `202`, the preview and its job. |
| `DELETE /api/hooks/preview` | `{ "pr": 42 }` or `{ "branch": "…" }` | Removes the preview's namespace. |

Header: `Authorization: Bearer kzt_…`. Answers: `401` unknown / expired / revoked token · `403` a value the token may not set, a protected environment (`PROTECTED`), or a token without previews · `409` read-only cluster · `423` change freeze · `400` bad input. The CVE gate and image signature policy of the environment apply; a token never overrides them.

```bash
curl -fsS -X POST https://<your-kubeez>/api/hooks/deploy \
  -H "Authorization: Bearer $KUBEEZ_TOKEN" -H "Content-Type: application/json" \
  -d '{"set": {"image.tag": "'"$GIT_SHA"'"}, "commit": {"sha": "'"$GIT_SHA"'", "time": "'"$(git log -1 --format=%cI)"'"}}'
```

## ChatOps — `/api/chatops/slack/:channelId`

The Slack slash command posts here; every request must carry Slack's signature made with the channel's signing secret (checked on the raw body, within 5 minutes). Telegram uses the channel's bot. Commands: questions for KubeEZ AI, `incidents`, `why 2`, `fix 2`, `deploy list`, `deploy web 1.4.2 to staging` → `confirm 4821`.

---

# Older endpoint reference

## Base URL
```
http://localhost:3000/api
```

## Authentication
Most endpoints require JWT authentication. Include the token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

---

## 🔐 Authentication Endpoints

### Register User
**POST** `/auth/register`

Create a new user account.

**Request Body:**
```json
{
  "username": "admin",
  "password": "securepassword123",
  "email": "admin@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "userId": "uuid-here"
}
```

---

### Login
**POST** `/auth/login`

Authenticate and receive JWT token.

**Request Body:**
```json
{
  "username": "admin",
  "password": "securepassword123"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid-here",
    "username": "admin",
    "email": "admin@example.com"
  }
}
```

---

## 🎯 Cluster Management Endpoints

### Install New Cluster
**POST** `/clusters/install`

🔒 **Requires Authentication**

Initiate a new Kubernetes cluster installation.

**Request Body:**
```json
{
  "clusterName": "production-cluster",
  "nodes": [
    {
      "hostname": "master-1",
      "ip": "192.168.1.10",
      "role": "master",
      "sshUser": "root",
      "sshPassword": "password",
      "sshKey": "-----BEGIN RSA PRIVATE KEY-----\n..."
    },
    {
      "hostname": "worker-1",
      "ip": "192.168.1.11",
      "role": "worker",
      "sshUser": "root",
      "sshPassword": "password"
    }
  ],
  "config": {
    "kubernetesVersion": "1.28.0",
    "podNetworkCIDR": "10.244.0.0/16",
    "serviceCIDR": "10.96.0.0/12",
    "networkPlugin": "calico"
  }
}
```

**Response:**
```json
{
  "success": true,
  "clusterId": "cluster-uuid",
  "message": "Installation started",
  "status": "installing"
}
```

---

### Get Cluster Status
**GET** `/clusters/:clusterId/status`

🔒 **Requires Authentication**

Get real-time status of cluster installation or operation.

**Response:**
```json
{
  "clusterId": "cluster-uuid",
  "name": "production-cluster",
  "status": "running",
  "progress": 100,
  "currentStep": "Installation Complete",
  "nodes": [
    {
      "hostname": "master-1",
      "ip": "192.168.1.10",
      "role": "master",
      "status": "ready",
      "health": {
        "cpu": "15%",
        "memory": "2.5GB / 8GB",
        "disk": "45GB / 100GB"
      }
    }
  ],
  "kubeconfig": "apiVersion: v1\nkind: Config\n...",
  "createdAt": "2026-01-22T12:00:00Z",
  "updatedAt": "2026-01-22T12:30:00Z"
}
```

---

### List All Clusters
**GET** `/clusters`

🔒 **Requires Authentication**

Get list of all clusters.

**Response:**
```json
{
  "success": true,
  "clusters": [
    {
      "id": "cluster-uuid-1",
      "name": "production-cluster",
      "status": "running",
      "nodeCount": 3,
      "createdAt": "2026-01-22T12:00:00Z"
    },
    {
      "id": "cluster-uuid-2",
      "name": "staging-cluster",
      "status": "installing",
      "nodeCount": 2,
      "createdAt": "2026-01-22T13:00:00Z"
    }
  ]
}
```

---

### Delete Cluster
**DELETE** `/clusters/:clusterId`

🔒 **Requires Authentication**

Remove cluster from management (does not destroy actual cluster).

**Response:**
```json
{
  "success": true,
  "message": "Cluster removed successfully"
}
```

---

### Download Kubeconfig
**GET** `/clusters/:clusterId/kubeconfig`

🔒 **Requires Authentication**

Download kubeconfig file for kubectl access.

**Response:**
```yaml
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: LS0tLS1...
    server: https://192.168.1.10:6443
  name: kubernetes
...
```

---

### Install Add-on
**POST** `/clusters/:clusterId/addons`

🔒 **Requires Authentication**

Install additional components to the cluster.

**Request Body:**
```json
{
  "addon": "monitoring",
  "config": {
    "grafanaPassword": "admin123"
  }
}
```

**Available Add-ons:**
- `ingress` - Nginx Ingress Controller
- `monitoring` - Prometheus + Grafana + Node Exporter + Kube-State-Metrics
- `dashboard` - Kubernetes Dashboard

**Response:**
```json
{
  "success": true,
  "message": "Add-on installation started",
  "addonId": "addon-uuid"
}
```

---

### Get Add-on Status
**GET** `/clusters/:clusterId/addons/:addonId`

🔒 **Requires Authentication**

Check installation status of an add-on.

**Response:**
```json
{
  "addonId": "addon-uuid",
  "name": "monitoring",
  "status": "installed",
  "endpoints": {
    "prometheus": "http://192.168.1.10:30090",
    "grafana": "http://192.168.1.10:30000"
  }
}
```

---

## 🏥 Health & System Endpoints

### Health Check
**GET** `/health`

Check if the API is running.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-01-22T18:00:00Z",
  "uptime": 3600
}
```

---

### Detailed Health Check
**GET** `/health/detailed`

Get detailed system health information.

**Response:**
```json
{
  "status": "healthy",
  "uptime": 3600,
  "memory": {
    "rss": 52428800,
    "heapTotal": 20971520,
    "heapUsed": 15728640,
    "external": 1048576
  },
  "timestamp": "2026-01-22T18:00:00Z",
  "version": "1.0.0"
}
```

---

## 🔌 WebSocket API

### Connect to WebSocket
**WS** `/ws`

Real-time updates for cluster installation progress.

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onopen = () => {
  console.log('Connected to KubeEZ WebSocket');
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Update:', data);
};
```

**Message Format:**
```json
{
  "type": "installation_progress",
  "clusterId": "cluster-uuid",
  "step": "Installing Kubernetes packages",
  "progress": 45,
  "status": "in_progress",
  "timestamp": "2026-01-22T18:00:00Z"
}
```

**Event Types:**
- `installation_progress` - Installation step updates
- `node_status` - Node health updates
- `error` - Error notifications
- `success` - Success notifications

---

## 📊 Error Responses

All endpoints may return error responses in this format:

**400 Bad Request:**
```json
{
  "success": false,
  "error": "Invalid request parameters",
  "details": "Missing required field: clusterName"
}
```

**401 Unauthorized:**
```json
{
  "success": false,
  "error": "Authentication required",
  "message": "Please provide a valid JWT token"
}
```

**404 Not Found:**
```json
{
  "success": false,
  "error": "Cluster not found",
  "clusterId": "invalid-uuid"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "Internal server error",
  "message": "An unexpected error occurred"
}
```

---

## 🔧 Rate Limiting

API endpoints are rate-limited to prevent abuse:
- **Limit:** 100 requests per 15 minutes per IP
- **Header:** `X-RateLimit-Remaining` shows remaining requests

**Rate Limit Response:**
```json
{
  "success": false,
  "error": "Too many requests",
  "retryAfter": 900
}
```

---

## 📝 Examples

### Complete Installation Flow

```javascript
// 1. Register/Login
const loginResponse = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: 'admin',
    password: 'password123'
  })
});
const { token } = await loginResponse.json();

// 2. Install Cluster
const installResponse = await fetch('http://localhost:3000/api/clusters/install', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    clusterName: 'my-cluster',
    nodes: [/* ... */],
    config: {/* ... */}
  })
});
const { clusterId } = await installResponse.json();

// 3. Monitor Progress via WebSocket
const ws = new WebSocket('ws://localhost:3000/ws');
ws.onmessage = (event) => {
  const update = JSON.parse(event.data);
  if (update.clusterId === clusterId) {
    console.log(`Progress: ${update.progress}%`);
  }
};

// 4. Get Final Status
const statusResponse = await fetch(`http://localhost:3000/api/clusters/${clusterId}/status`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
const status = await statusResponse.json();

// 5. Download Kubeconfig
const kubeconfigResponse = await fetch(`http://localhost:3000/api/clusters/${clusterId}/kubeconfig`, {
  headers: { 'Authorization': `Bearer ${token}` }
});
const kubeconfig = await kubeconfigResponse.text();
```

---

## 🔗 Additional Resources

- [Installation Guide](./REAL_INSTALLATION_GUIDE.md)
- [Troubleshooting](./TROUBLESHOOTING.md)
- [Contributing](./CONTRIBUTING.md)
- [GitHub Repository](https://github.com/ckmine11/Universal-K8s-Installer)
