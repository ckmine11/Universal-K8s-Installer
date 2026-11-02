# KubeEZ Docker Guide

*Version 2.3.0 · November 2026.* Everything about running KubeEZ in Docker: the images, the two compose files, data, updates, backups and troubleshooting. The short version: [DOCKER_QUICKSTART.md](DOCKER_QUICKSTART.md). Full server setup: [SETUP.md](SETUP.md).

---

## 1. Requirements

- **Linux server:** Docker Engine with the Compose plugin (`curl -fsSL https://get.docker.com | sudo sh`).
- **Windows / macOS (development):** Docker Desktop.
- About 1 GB RAM for KubeEZ itself (production limits: backend 512 MB, frontend 128 MB) and a few GB of disk for images and data.

---

## 2. The images

| Image | Built from | Contents |
|---|---|---|
| **backend** | `backend/Dockerfile` | Node.js 22 (Alpine) running `src/server.js` on port 3000; **kubectl 1.34**, **helm 3.19** and **bash** copied from official images (for connected clusters, run in a per-cluster sandbox); the Gateway Agent bundle built at image build time. Health check on `/api/health`. No `apk add`, so it builds behind firewalls that block the Alpine CDN. |
| **frontend** | `frontend/Dockerfile` | The React console built with Vite (Node 22), served by nginx on port 80. Its nginx sends the page security headers. |
| **proxy** (production only) | `nginx:alpine` + `nginx/production.conf` | Routes `/api`, `/ws`, the Explorer streams and the agent downloads to the backend, everything else to the frontend; restores the visitor's IP from Cloudflare. |

---

## 3. The two compose files

| | `docker-compose.yml` (development) | `docker-compose.prod.yml` (production) |
|---|---|---|
| Ports | backend `3000`, console `5173` | proxy `80` and `8090` (backend and frontend not published) |
| Mode | `KUBEEZ_MODE` from `.env`, default `saas` | same |
| Settings | `KUBEEZ_MODE`, `APP_SECRET` and fixed dev values | every setting from `.env` (see `.env.example`) |
| Code | `./backend/src` mounted (edit and restart) | baked into the image |
| Data | `./backend/data`, `./backend/logs` (folders) | volumes `kubeez-data`, `kubeez-logs` |
| Limits | none | backend 512 MB, frontend 128 MB |

Compose reads `.env` in the project folder for the `${…}` values. Every setting is explained in [SETUP.md](SETUP.md#3-configure).

---

## 4. Commands

Add `-f docker-compose.prod.yml` to each command in production.

```bash
# start / build
docker compose up -d --build               # build and start everything
docker compose up -d --build backend       # rebuild one service
docker compose build --no-cache            # clean rebuild

# look
docker compose ps                          # state and health
docker compose logs -f backend             # follow a log
docker compose logs --tail 200 proxy
docker stats                               # CPU / memory per container

# inside
docker exec -it kubeez-backend sh
docker exec -it kubeez-backend node scripts/make-superadmin.js <user> <password> <email>   # SaaS platform owner
docker exec -it kubeez-backend node scripts/reset-password.js <user> <new-password>

# stop
docker compose restart backend
docker compose down                        # stop; data is kept
docker compose down -v                     # stop AND DELETE the volumes (all KubeEZ data) — careful
```

---

## 5. Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build backend frontend
```

Data in the volumes is kept. Read [CHANGELOG.md](CHANGELOG.md) first, and update when no install, upgrade or restore is running — a restart stops jobs in progress (a stopped install can be resumed from the console).

---

## 6. Data and backups

`/app/data` (volume `kubeez-data`) holds everything: clusters (credentials encrypted), users, settings, delivery data, alert channels, AI settings, the audit trail, license and System ID, and — when `APP_SECRET` is not set — `master.key`.

Back it up together with your `.env` (or at least `APP_SECRET`):

```bash
docker run --rm -v kubeez-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/kubeez-data-$(date +%F).tgz -C /data .
```

Restore onto a stopped server:

```bash
docker compose -f docker-compose.prod.yml down
docker run --rm -v kubeez-data:/data -v "$PWD":/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/kubeez-data-YYYY-MM-DD.tgz -C /data"
docker compose -f docker-compose.prod.yml up -d
```

KubeEZ also keeps daily copies of its own data inside the volume (`data/backups`) — useful for mistakes, not for a lost disk.

---

## 7. HTTPS and domains

The production proxy speaks plain HTTP on port 80. Put HTTPS in front:

- **Cloudflare** in front of port 80 — [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md).
- **Your own reverse proxy** with a certificate, forwarding to port 80 or 8090 with WebSocket upgrades and long timeouts — the host-nginx example in [MULTI_SITE_SETUP.md](MULTI_SITE_SETUP.md) works for one site too.

Then set `KUBEEZ_PUBLIC_URL=https://…` in `.env` and restart the backend.

---

## 8. Troubleshooting

| Symptom | Look at | Fix |
|---|---|---|
| Backend restarts in a loop | `docker compose logs backend` | Production refuses an `APP_SECRET` shorter than 32 characters or the shipped placeholder — set a real one. |
| Proxy waits forever | `docker compose ps` | The proxy starts only when the backend is healthy (up to ~40 s); see the backend log. |
| `Bind for 0.0.0.0:80 failed` | `sudo ss -ltnp \| grep :80` | Another web server owns port 80 — stop it, or follow [MULTI_SITE_SETUP.md](MULTI_SITE_SETUP.md). |
| Console shows "Bad gateway" | proxy and backend logs | The backend is down or still starting. |
| Explorer / terminal do not connect | the proxy in front of KubeEZ | WebSocket `Upgrade` headers are not passed through. |
| Image build fails on `npm install` | build output | The server cannot reach the npm registry (proxy / firewall). |
| Settings in `.env` have no effect | `docker compose config` | Only the variables listed in the compose file are passed — check the name, then `up -d backend`. |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
