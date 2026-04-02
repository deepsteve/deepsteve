# Runs server directly from repo source (npm ci + node server.js).
# Used by docker-compose.yml for standard integration tests.
# See also: Dockerfile.public (published install.sh), Dockerfile.install (local install.sh).
FROM node:22-bookworm

# zsh: server.js spawns 'zsh -l' for all session types
# curl: used by docker-compose healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends zsh curl tmux && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Copy application source
COPY . .

# Create ~/.deepsteve directory that the server expects
RUN mkdir -p /root/.deepsteve

EXPOSE 3000

CMD ["node", "server.js"]
