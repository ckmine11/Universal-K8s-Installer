# Deploying KubeEZ

*Version 2.3.0 · November 2026.* Where to host the KubeEZ server and how to put it online. Configuration details: [SETUP.md](SETUP.md) · Docker details: [DOCKER_GUIDE.md](DOCKER_GUIDE.md).

---

## 1. Where to run it

Run KubeEZ on a **Linux server or VPS with Docker** — any cloud or your own hardware.

| Why a server | |
|---|---|
| **Persistent data** | KubeEZ keeps clusters, credentials (encrypted), settings and the audit trail on disk. |
| **Long jobs** | Installs, upgrades and restores take minutes and run in the background. |
| **Outbound connections** | SSH to your nodes (self-hosted), WebSockets from Gateway Agents and KubeEZ agents. |

**Size:** 2 vCPU, 4 GB RAM and 20 GB disk are plenty; KubeEZ itself uses under 1 GB of memory.

**Not suitable:** serverless or "free web app" platforms (Vercel, Render free tier, Heroku-style dynos) — their disks are wiped on restart and they cut long requests, so data is lost and installs break.

**Where it must sit:**
- **Self-hosted** (`KUBEEZ_MODE=selfhosted`): somewhere that can reach your cluster servers over SSH — or anywhere, with a Gateway Agent in each private network.
- **Hosted** (`saas`): a public server; customers' private servers are reached only through their Gateway Agents.

---

## 2. The quick way: `deploy.sh`

On the server, in the cloned repository:

```bash
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/ckmine11/Universal-K8s-Installer.git && cd Universal-K8s-Installer
bash deploy.sh
```

`deploy.sh` checks Docker, creates `.env` from the `.env.production` template with a freshly generated `APP_SECRET` (it also replaces the placeholder in an existing `.env`), rebuilds the production stack and waits until `http://localhost:8090/api/health` answers.

Then edit `.env` (`KUBEEZ_MODE`, `KUBEEZ_PUBLIC_URL`, `ALLOWED_ORIGINS`, `SMTP_*`…) and apply it:

```bash
docker compose -f docker-compose.prod.yml up -d backend
```

## 3. The manual way

```bash
cp .env.example .env              # set APP_SECRET=$(openssl rand -hex 32), KUBEEZ_MODE, KUBEEZ_PUBLIC_URL…
docker compose -f docker-compose.prod.yml up -d --build
curl -s http://localhost:8090/api/health            # {"status":"healthy",…}
```

---

## 4. Put it online

1. **HTTPS in front** of port 80 — Cloudflare ([CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)) or your own reverse proxy with a certificate. Pass WebSocket upgrades and use long read timeouts (the Explorer and terminals stream).
2. **Firewall:** open 80 (and 443 on your own proxy) to the internet — or only to Cloudflare. KubeEZ needs nothing else inbound; Gateway Agents and KubeEZ agents connect out to it.
3. **Sharing the server with other sites:** [MULTI_SITE_SETUP.md](MULTI_SITE_SETUP.md).

---

## 5. Security checklist — do not skip

- [ ] **`APP_SECRET`** is a real random value (`openssl rand -hex 32`). In production the backend refuses to start with the template placeholder or anything shorter than 32 characters — that placeholder is public, and anyone could forge logins and decrypt stored SSH credentials with it.
- [ ] **The platform owner exists.**
  - *Self-hosted:* the first account is created on the setup screen — do it right after the first start, before anyone else can open the page.
  - *Hosted:* sign-ups are ordinary workspace admins; create the platform owner on the server, then restart the backend:
    ```bash
    docker compose -f docker-compose.prod.yml exec backend node scripts/make-superadmin.js <username> '<strong password>' <email>
    docker compose -f docker-compose.prod.yml restart backend
    ```
- [ ] **`KUBEEZ_PUBLIC_URL`** and **`ALLOWED_ORIGINS`** are the exact https address people open. `ALLOWED_ORIGINS` is used for CORS and to refuse WebSocket connections from other web pages.
- [ ] **HTTPS only** — never send logins or Gateway Agent tokens over plain HTTP.
- [ ] **Backups** of the `kubeez-data` volume and `.env`, stored off the server ([DOCKER_GUIDE.md](DOCKER_GUIDE.md#6-data-and-backups)).
- [ ] **Email** set up (`SMTP_*`) so password resets and alerts work.
- [ ] Hosted edition: KubeEZ never opens SSH or webhooks from the server to private or internal addresses. Only if KubeEZ runs inside the same private network as the clusters, set `KUBEEZ_ALLOW_PRIVATE_SSH=true`.

---

## 6. Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build backend frontend
```

Update when no install, upgrade or restore is running. Data in the volumes is kept. See [CHANGELOG.md](CHANGELOG.md).
