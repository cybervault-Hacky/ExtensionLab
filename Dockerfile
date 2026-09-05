# syntax=docker/dockerfile:1.7
#
# ExtensionLab application image (web + worker).
#
#   docker build --target web    -t extensionlab-web:latest .
#   docker build --target worker -t extensionlab-worker:latest .
#
# Both targets run as a non-root user, contain production dependencies only,
# and never include the Docker CLI in the web image. The worker image ships
# the Docker CLI because it must create disposable sandbox containers through
# the host's Docker daemon (see docs/DEPLOYMENT.md for the security model).

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------------------
# deps: install all dependencies from the lockfile (build-time only)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# build: compile the Next.js app (standalone output)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# prod-deps: production dependencies for the worker (no dev tooling)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------------------------------------------------------------------------
# web: Next.js standalone server
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS web
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    APP_ENV=production \
    WORKER_MODE=external \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 extensionlab \
 && useradd --system --uid 10001 --gid extensionlab --home /app --shell /usr/sbin/nologin extensionlab \
 && mkdir -p /data /data/storage && chown -R extensionlab:extensionlab /data
COPY --from=build --chown=extensionlab:extensionlab /app/.next/standalone ./
COPY --from=build --chown=extensionlab:extensionlab /app/.next/static ./.next/static
COPY --from=build --chown=extensionlab:extensionlab /app/public ./public
# Migration runner + SQL files so `db:migrate` can run from this image.
COPY --from=build --chown=extensionlab:extensionlab /app/scripts/db-migrate.mjs ./scripts/db-migrate.mjs
COPY --from=build --chown=extensionlab:extensionlab /app/lib/db/migrations ./lib/db/migrations
COPY --chown=extensionlab:extensionlab docker/entrypoint.sh /usr/local/bin/extensionlab-entrypoint
RUN chmod 0755 /usr/local/bin/extensionlab-entrypoint
USER extensionlab
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["extensionlab-entrypoint"]
CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
# worker: background job runner (needs the Docker CLI to drive sandboxes)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS worker
WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production \
    WORKER_MODE=external
ARG DOCKER_CLI_VERSION=27.5.1
# Docker CLI only (no daemon). The socket is mounted at runtime and access to
# it is equivalent to root on the host: run the worker on a dedicated host or
# behind a socket proxy (see docs/SECURITY.md).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in amd64) DOCKER_ARCH=x86_64 ;; arm64) DOCKER_ARCH=aarch64 ;; *) echo "unsupported arch $ARCH" && exit 1 ;; esac \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ARG DOCKER_GID=999
RUN groupadd --system --gid 10001 extensionlab \
 && useradd --system --uid 10001 --gid extensionlab --home /app --shell /usr/sbin/nologin extensionlab \
 && (getent group "${DOCKER_GID}" || groupadd --gid "${DOCKER_GID}" dockerhost) \
 && usermod -aG "${DOCKER_GID}" extensionlab \
 && mkdir -p /data /data/storage /tmp/extensionlab-runtime && chown -R extensionlab:extensionlab /data /tmp/extensionlab-runtime
COPY --from=prod-deps --chown=extensionlab:extensionlab /app/node_modules ./node_modules
COPY --chown=extensionlab:extensionlab package.json package-lock.json tsconfig.json ./
COPY --chown=extensionlab:extensionlab lib ./lib
COPY --chown=extensionlab:extensionlab types ./types
COPY --chown=extensionlab:extensionlab scripts ./scripts
COPY --chown=extensionlab:extensionlab docker/entrypoint.sh /usr/local/bin/extensionlab-entrypoint
RUN chmod 0755 /usr/local/bin/extensionlab-entrypoint
USER extensionlab
VOLUME ["/data"]
ENTRYPOINT ["extensionlab-entrypoint"]
CMD ["npm", "run", "worker"]
