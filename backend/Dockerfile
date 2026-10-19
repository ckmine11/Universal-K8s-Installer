# Backend Dockerfile
#
# kubectl, helm and bash for imported clusters (EKS, AKS, GKE, OKE, k3s… added
# with a kubeconfig or the KubeEZ agent): KubeEZ runs the same scripts there
# against the Kubernetes API, in a sandbox (services/clusterAccess.js). Taken
# from the official images — no Alpine package CDN needed.
FROM registry.k8s.io/kubectl:v1.34.1 AS kubectl
FROM alpine/helm:3.19.0 AS helm
FROM bash:5.2 AS bash

FROM node:22-alpine
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY --from=helm /usr/bin/helm /usr/local/bin/helm
COPY --from=bash /usr/local/bin/bash /usr/local/bin/bash
COPY --from=bash /usr/lib/libncursesw.so.6* /usr/lib/

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
COPY scripts ./scripts
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
