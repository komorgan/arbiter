# Arbiter Server (Managed mode) image.
#
# Agents run in sibling Docker containers through the host's Docker socket, so the server's data dir must be
# mounted at the SAME path inside and outside the container: workspace bind mounts are resolved by the host's
# Docker daemon. See deploy/docker-compose.yml.

# ---- build: bundle the server into one file ----
FROM node:24-bookworm-slim AS build
WORKDIR /src
# The desktop toolchain (Electron) isn't needed to build the server.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs --server

# ---- runtime ----
FROM node:24-bookworm-slim
# git snapshots workspaces and captures diffs; the docker CLI launches sandbox containers on the host daemon.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY --from=build /src/dist/arbiter.mjs ./dist/arbiter.mjs
COPY public ./public
COPY examples ./examples

ENV NODE_ENV=production \
    ARBITER_HOME=/srv/arbiter \
    ARBITER_HOST=0.0.0.0 \
    ARBITER_PORT=8080
# Runs as the unprivileged "node" user. To reach the Docker socket, add its group at run time
# (docker run --group-add <gid of /var/run/docker.sock>). Note that socket access is root-equivalent on the host.
RUN mkdir -p /srv/arbiter && chown node:node /srv/arbiter
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8080/api/auth/me').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "dist/arbiter.mjs", "server"]
