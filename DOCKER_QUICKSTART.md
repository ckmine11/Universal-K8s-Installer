# KubeEZ with Docker — Quick Start

*Version 2.3.0 · November 2026.* The shortest way to run KubeEZ. Details: [DOCKER_GUIDE.md](DOCKER_GUIDE.md) · production: [SETUP.md](SETUP.md).

---

## Try it locally (development)

```bash
git clone https://github.com/ckmine11/Universal-K8s-Installer.git
cd Universal-K8s-Installer
cp .env.example .env
docker compose up -d --build
```

| | Address |
|---|---|
| Console | http://localhost:5173 |
| API | http://localhost:3000/api/health |

The development compose runs in **SaaS mode** by default. Either create the platform owner:

```bash
docker exec -it kubeez-backend node scripts/make-superadmin.js admin 'a-strong-password' admin@example.com
docker compose restart backend
```

or set `KUBEEZ_MODE=selfhosted` in `.env` before the first start — then the first screen creates the first administrator.

## Run it for real (production)

```bash
cp .env.example .env              # set APP_SECRET (openssl rand -hex 32), KUBEEZ_MODE, KUBEEZ_PUBLIC_URL, SMTP_*
docker compose -f docker-compose.prod.yml up -d --build
```

nginx answers on **:80** (and **:8090**); put HTTPS in front (Cloudflare or your own proxy). See [SETUP.md](SETUP.md).

## Everyday commands

```bash
docker compose ps                                  # what runs (add -f docker-compose.prod.yml in production)
docker compose logs -f backend                     # follow the backend log
docker compose restart backend                     # restart one service
git pull && docker compose up -d --build           # update
docker compose down                                # stop (data stays)
```

## What it creates

| | Development | Production |
|---|---|---|
| Containers | `kubeez-backend`, `kubeez-frontend` | `kubeez-proxy`, `kubeez-backend`, `kubeez-frontend` |
| KubeEZ data | `./backend/data` (a folder) | volume `kubeez-data` |
| Logs | `./backend/logs` | volume `kubeez-logs` |

**Back up the data** (and keep `APP_SECRET` with it) — it holds your clusters, credentials (encrypted), settings and audit trail.

## If something is wrong

| Problem | Fix |
|---|---|
| Port already in use | Stop what uses 3000 / 5173 (or 80 / 8090), or change the left side of `ports:` in the compose file. |
| The console loads but sign-in fails | `docker compose logs backend` — usually `APP_SECRET` too short in production, or the backend still starting (healthcheck). |
| Build fails downloading packages | Check the server's internet / proxy; `docker compose build --no-cache`. |
