# ExtensionLab disposable sandbox image.
# The container runs a non-root node user, drops capabilities, uses a read-only
# root filesystem, and only has writable tmpfs directories.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     chromium \
     xvfb \
     fonts-liberation \
     ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/runner
COPY sandbox/package.json ./
COPY sandbox/runner ./runner
COPY sandbox/tsconfig.json sandbox/tsconfig.build.json ../

RUN npm install --no-audit --no-fund
RUN npm run build

USER node

EXPOSE 9333

# Managed by the host SandboxManager via docker run; no shell is exposed.
CMD ["node", "dist/runner/index.js"]
