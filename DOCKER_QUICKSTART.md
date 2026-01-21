# 🐳 KubeEZ - Docker Quick Start

## ⚡ One Command Setup

```powershell
cd C:\Users\Joy\.gemini\antigravity\scratch\kubeez
docker-compose up --build
```

**Access at:** http://localhost:5173 🚀

---

## 📋 Essential Commands

### Start
```powershell
docker-compose up              # Start (foreground)
docker-compose up -d           # Start (background)
docker-compose up --build      # Build and start
```

### Stop
```powershell
docker-compose down            # Stop all
docker-compose stop            # Stop (keep containers)
docker-compose restart         # Restart all
```

### Logs
```powershell
docker-compose logs            # View all logs
docker-compose logs -f         # Follow logs
docker-compose logs backend    # Backend logs only
docker-compose logs frontend   # Frontend logs only
```

### Status
```powershell
docker-compose ps              # List containers
docker ps                      # All running containers
```

### Cleanup
```powershell
docker-compose down -v         # Remove containers + volumes
docker system prune -a         # Clean everything
```

---

## 🎯 What Gets Created

### Containers
- `kubeez-backend` - Node.js API (port 3000)
- `kubeez-frontend` - React + Nginx (port 5173)

### Network
- `kubeez-network` - Bridge network for communication

### Volumes
- Backend logs mounted to `./backend/logs`

---

## 🔍 Troubleshooting

### Port Already in Use
```powershell
# Change ports in docker-compose.yml
ports:
  - "3001:3000"  # Backend
  - "5174:80"    # Frontend
```

### Build Fails
```powershell
docker-compose down -v
docker-compose build --no-cache
docker-compose up
```

### Cannot Connect
```powershell
# Check if running
docker-compose ps

# Check logs
docker-compose logs backend

# Test backend
curl http://localhost:3000/api/health
```

---

## 📁 Files Created

```
kubeez/
├── docker-compose.yml          # Main orchestration
├── .env.example                # Environment template
├── DOCKER_GUIDE.md             # Full documentation
│
├── backend/
│   ├── Dockerfile              # Backend image
│   └── .dockerignore           # Exclude files
│
└── frontend/
    ├── Dockerfile              # Frontend image
    ├── nginx.conf              # Nginx config
    └── .dockerignore           # Exclude files
```

---

## ✅ Verification

After starting, check:

1. **Backend Health**: http://localhost:3000/api/health
2. **Frontend UI**: http://localhost:5173
3. **Container Status**: `docker-compose ps`
4. **Logs**: `docker-compose logs -f`

---

## 🚀 Next Steps

1. ✅ Run `docker-compose up --build`
2. ✅ Open http://localhost:5173
3. ✅ Test the wizard flow
4. ✅ Monitor logs in terminal

---

**For detailed documentation, see:** `DOCKER_GUIDE.md`
