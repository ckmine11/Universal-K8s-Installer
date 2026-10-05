# 🚀 Deployment Guide for KubeEZ

## 🏆 The "Best Way" (Recommended)
**Use a Linux VPS + Docker Compose.**

For this specific application (which runs long installation scripts and saves local data), using a **Virtual Private Server (VPS)** is the only robust solution. 

**Why?**
*   **Persistence**: Free PaaS (Render/Vercel) will **delete your `clusters.json` data** every time they restart. A VPS keeps your data forever.
*   **No Timeouts**: Installation scripts take time (5-10 mins). Web hosts often kill connections after 60 seconds. A VPS has no execution limits.
*   **SSH Access**: You need stable outbound SSH connections to your nodes.

### 💰 Best Free VPS Options:
1.  **Oracle Cloud Always Free** (Best performance: 4 OCPUs, 24GB RAM - ARM Ampere).
2.  **Google Cloud Free Tier** (e2-micro).
3.  **AWS Free Tier** (t2.micro/t3.micro - 12 months only).

---

## 🛠️ Deployment Steps (On Your VPS)

### 1. Prerequisite: Install Docker
SSH into your VPS and install Docker & Docker Compose:
```bash
# Ubuntu/Debian/Oracle Linux
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER && newgrp docker
```

### 2. Upload Code
You can clone your git repo directly on the VPS:
```bash
git clone https://github.com/YOUR_USERNAME/kubeez.git
cd kubeez
```

### 3. Run Production Build
Use the simplified request to build and run everything in the background:
```bash
docker compose up -d --build
```

### 4. Access KubeEZ
Open your browser and visit: `http://YOUR_VPS_IP`
*   *Note*: Ensure port `80` (or the port defined in docker-compose) is open in your Security Group/Firewall.

### 5. Security checklist (do not skip)
*   **`APP_SECRET`** must be a real random value (`openssl rand -hex 32`). `deploy.sh` generates one;
    with the placeholder from `.env.production` the backend **refuses to start** in production —
    that placeholder is public, and anyone could forge logins and decrypt stored SSH credentials.
*   **Platform Super Admin**
    *   *Self-hosted*: the first account is created on the **setup screen**; sign-up is closed until then.
    *   *SaaS (`KUBEEZ_MODE=saas`)*: sign-ups are always ordinary workspace admins. Create the platform
        admin on the server, then restart the backend:
        ```bash
        docker compose exec backend node scripts/make-superadmin.js <username> '<strong password>' [email]
        docker compose restart backend
        ```
*   **`ALLOWED_ORIGINS`** = the exact URL users open (e.g. `https://kubeez.example.com`). It is used for
    CORS and to refuse WebSocket connections from other web pages.
*   In SaaS mode KubeEZ never opens SSH from the server into private/internal addresses — customers'
    private servers are reached through their Gateway Agent. (Only if KubeEZ runs inside the same private
    network as the clusters, set `KUBEEZ_ALLOW_PRIVATE_SSH=true`.)

---

## 🏠 Easiest Way (Local)
If you just want to manage clusters from your laptop:
1.  Install **Docker Desktop**.
2.  Open terminal in this project folder.
3.  Run: `docker compose up -d --build`
4.  Open `http://localhost`

---

## ⚠️ Why NOT Vercel/Render? (Read Carefully)
While you *can* use Vercel (Frontend) and Render (Backend):
1.  **Data Loss**: Render's ephemeral filesystem will delete your cluster list daily.
2.  **Broken Installs**: Render has a hard request timeout. If K8s installation takes >100 seconds, the frontend will show an error, even if the backend is still working (or it might be killed).
**Use these only for testing the UI, not for real usage.**
