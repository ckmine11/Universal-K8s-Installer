# Backend Dockerfile
FROM node:18-alpine

# NOTE: No `apk add` — avoids dependency on the Alpine package CDN, which may be
# blocked by firewalls/proxies on some servers. Healthchecks use node/wget
# (busybox wget is already present in the base image).

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code and build script
COPY src ./src
COPY build-agent.js ./

# Build agent bundle into public/agent-bundle.js
RUN node build-agent.js

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "src/server.js"]
