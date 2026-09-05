# ExtensionLab disposable sandbox image — Chromium runtime.
#
# Identical security profile to sandbox/Dockerfile (non-root node user,
# dropped capabilities, read-only root filesystem, tmpfs-only writes). This
# copy exists so per-browser images can be built explicitly:
#   npm run sandbox:build:chromium
#
# Browser version policy: the installed Chromium version is whatever the
# pinned Debian base ships at build time. Record/override the deployment-level
# version label with BROWSER_CHROMIUM_VERSION; the runner still detects and
# reports the exact version per execution.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV EXTENSIONLAB_BROWSER=chromium

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     xvfb \
     fonts-liberation \
     ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY sandbox/package.json ./runner/package.json
COPY sandbox/runner ./runner
COPY sandbox/tsconfig.json ./tsconfig.json
COPY sandbox/tsconfig.build.json ./tsconfig.build.json

RUN cd runner && npm install --no-audit --no-fund
RUN npm run build

USER node
WORKDIR /app

EXPOSE 9333

# Managed by the host SandboxManager via docker run; no shell is exposed.
CMD ["node", "dist/runner/index.js"]
