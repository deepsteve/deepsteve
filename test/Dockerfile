# Runs server directly from repo source (npm ci + node server.js).
# Used by docker-compose.yml for standard integration tests.
# See also: Dockerfile.public (published install.sh), Dockerfile.install (local install.sh).
FROM node:22-bookworm

# NO zsh, deliberately (#621). server.js used to spawn a literal `zsh -l` for every
# session; it now resolves the login shell ($SHELL, else the passwd entry, else
# zsh/bash/sh), so this image is the regression test for that: root's passwd shell in
# node:22-bookworm is /bin/bash, which is exactly the fallback path a real Linux box
# takes. Re-adding zsh here would make the whole suite blind to a zsh dependency
# creeping back in — the same trick #619 used with the bare CI unit runner.
# curl: used by docker-compose healthcheck. tmux: the default engine since #620.
RUN apt-get update && apt-get install -y --no-install-recommends curl tmux && rm -rf /var/lib/apt/lists/*

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
