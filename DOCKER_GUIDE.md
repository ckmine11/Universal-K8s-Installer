# 🐳 KubeEZ - Docker Deployment Guide

## 📋 Prerequisites

- **Docker**: Version 20.10 or higher
- **Docker Compose**: Version 2.0 or higher

### Install Docker Desktop (Windows)

1. Download from: https://www.docker.com/products/docker-desktop/
2. Install and restart your computer
3. Verify installation:
```powershell
docker --version
docker-compose --version
```

---

## 🚀 Quick Start with Docker Compose

### 1. Build and Start All Services

```powershell
# Navigate to project directory
cd C:\Users\Joy\.gemini\antigravity\scratch\kubeez

# Build and start all services
docker-compose up --build
```

**That's it!** 🎉 Your application is now running:
- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000
- **Health Check**: http://localhost:3000/api/health

### 2. Run in Background (Detached Mode)

```powershell
# Start services in background
docker-compose up -d --build

# View logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f backend
docker-compose logs -f frontend
```

### 3. Stop Services

```powershell
# Stop all services
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

---

## 🔧 Docker Commands Reference

### Building

```powershell
# Build all services
docker-compose build

# Build specific service
docker-compose build backend
docker-compose build frontend

# Build without cache
docker-compose build --no-cache
```

### Running

```powershell
# Start services
docker-compose up

# Start in background
docker-compose up -d

# Start specific service
docker-compose up backend
```

### Monitoring

```powershell
# View running containers
docker-compose ps

# View logs (all services)
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# View last 100 lines
docker-compose logs --tail=100

# View specific service logs
docker-compose logs backend
docker-compose logs frontend
```

### Managing

```powershell
# Stop services
docker-compose stop

# Start stopped services
docker-compose start

# Restart services
docker-compose restart

# Restart specific service
docker-compose restart backend

# Remove stopped containers
docker-compose rm
```

### Cleanup

```powershell
# Stop and remove containers
docker-compose down

# Remove containers and volumes
docker-compose down -v

# Remove containers, volumes, and images
docker-compose down -v --rmi all

# Remove all unused Docker resources
docker system prune -a
```

---

## 📁 Docker Files Overview

### 1. `docker-compose.yml`
Main orchestration file that defines:
- **backend** service (Node.js API)
- **frontend** service (React + Nginx)
- **Network** configuration
- **Volume** mounts
- **Health checks**

### 2. `backend/Dockerfile`
Backend container configuration:
- Base image: `node:18-alpine`
- Installs dependencies
- Copies source code
- Exposes port 3000
- Runs Node.js server

### 3. `frontend/Dockerfile`
Frontend multi-stage build:
- **Stage 1**: Build React app with Node.js
- **Stage 2**: Serve with Nginx
- Optimized production build
- Smaller final image size

### 4. `frontend/nginx.conf`
Nginx configuration:
- Serves static files
- Proxies API requests to backend
- WebSocket support
- Security headers
- Caching strategy

---

## 🔍 Troubleshooting

### Problem: Port Already in Use

```powershell
# Find process using port 3000
netstat -ano | findstr :3000

# Kill the process (replace PID)
taskkill /PID <PID> /F

# Or change port in docker-compose.yml
ports:
  - "3001:3000"  # Use 3001 instead
```

### Problem: Build Fails

```powershell
# Clean Docker cache
docker-compose down -v
docker system prune -a

# Rebuild from scratch
docker-compose build --no-cache
docker-compose up
```

### Problem: Cannot Connect to Backend

```powershell
# Check if backend is running
docker-compose ps

# Check backend logs
docker-compose logs backend

# Verify health check
curl http://localhost:3000/api/health
```

### Problem: Frontend Shows Blank Page

```powershell
# Check frontend logs
docker-compose logs frontend

# Rebuild frontend
docker-compose build --no-cache frontend
docker-compose up frontend
```

### Problem: WebSocket Connection Fails

```powershell
# Check nginx configuration
docker-compose exec frontend cat /etc/nginx/conf.d/default.conf

# Restart services
docker-compose restart
```

---

## 🔐 Environment Variables

### Create `.env` file

```powershell
# Copy example file
copy .env.example .env

# Edit .env file with your values
notepad .env
```

### Example `.env` file:

```env
# Backend
NODE_ENV=production
PORT=3000

# Frontend (build time)
VITE_API_URL=http://localhost:3000
```

---

## 📊 Container Health Monitoring

### Check Container Health

```powershell
# View container health status
docker-compose ps

# Inspect specific container
docker inspect kubeez-backend

# View health check logs
docker inspect --format='{{json .State.Health}}' kubeez-backend
```

### Health Check Endpoints

- **Backend**: http://localhost:3000/api/health
- **Frontend**: http://localhost:5173 (should load UI)

---

## 🚀 Production Deployment

### Build Production Images

```powershell
# Build optimized production images
docker-compose -f docker-compose.yml build

# Tag images for registry
docker tag kubeez-backend:latest yourusername/kubeez-backend:v1.0.0
docker tag kubeez-frontend:latest yourusername/kubeez-frontend:v1.0.0

# Push to Docker Hub
docker push yourusername/kubeez-backend:v1.0.0
docker push yourusername/kubeez-frontend:v1.0.0
```

### Deploy to Server

```bash
# On production server
git clone https://github.com/yourusername/kubeez.git
cd kubeez

# Create .env file with production values
nano .env

# Start services
docker-compose up -d

# View logs
docker-compose logs -f
```

---

## 🔄 Development with Docker

### Hot Reload Development Mode

Create `docker-compose.dev.yml`:

```yaml
version: '3.8'

services:
  backend:
    build:
      context: ./backend
    volumes:
      - ./backend/src:/app/src
    command: node --watch src/server.js
    
  frontend:
    build:
      context: ./frontend
      target: builder
    volumes:
      - ./frontend/src:/app/src
    command: npm run dev
    ports:
      - "5173:5173"
```

Run development mode:
```powershell
docker-compose -f docker-compose.dev.yml up
```

---

## 📈 Performance Optimization

### Reduce Image Size

```powershell
# View image sizes
docker images | findstr kubeez

# Use multi-stage builds (already implemented)
# Use Alpine base images (already implemented)
# Remove unnecessary files (.dockerignore)
```

### Optimize Build Time

```powershell
# Use build cache
docker-compose build

# Parallel builds
docker-compose build --parallel
```

---

## 🔒 Security Best Practices

### 1. Don't Run as Root

Add to Dockerfile:
```dockerfile
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs
```

### 2. Scan for Vulnerabilities

```powershell
# Scan images
docker scan kubeez-backend
docker scan kubeez-frontend
```

### 3. Use Secrets

```powershell
# Don't commit .env file
# Use Docker secrets in production
# Use environment variables for sensitive data
```

---

## 📚 Additional Resources

### Docker Documentation
- Docker Compose: https://docs.docker.com/compose/
- Dockerfile Best Practices: https://docs.docker.com/develop/develop-images/dockerfile_best-practices/
- Multi-stage Builds: https://docs.docker.com/build/building/multi-stage/

### Nginx
- Nginx Docs: https://nginx.org/en/docs/
- Reverse Proxy: https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/

---

## 🎯 Common Use Cases

### 1. Development

```powershell
docker-compose up
# Edit code, see changes reflected
```

### 2. Testing

```powershell
docker-compose up -d
# Run tests against containers
docker-compose down
```

### 3. Production

```powershell
docker-compose up -d
# Monitor with logs
docker-compose logs -f
```

### 4. CI/CD

```yaml
# .github/workflows/docker.yml
- name: Build and Test
  run: |
    docker-compose build
    docker-compose up -d
    # Run tests
    docker-compose down
```

---

## ✅ Verification Checklist

After running `docker-compose up`, verify:

- [ ] Backend container is running: `docker-compose ps`
- [ ] Frontend container is running: `docker-compose ps`
- [ ] Backend health check passes: http://localhost:3000/api/health
- [ ] Frontend loads: http://localhost:5173
- [ ] API calls work from frontend
- [ ] WebSocket connection works
- [ ] Logs are visible: `docker-compose logs`

---

## 🎉 Success!

Your KubeEZ application is now running in Docker! 🐳

**Access your application:**
- Frontend: http://localhost:5173
- Backend: http://localhost:3000

**Next steps:**
1. Test the wizard flow
2. Configure a test cluster
3. Monitor installation logs
4. Deploy to production

---

**Happy Dockerizing! 🚀**
