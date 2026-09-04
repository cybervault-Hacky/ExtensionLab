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
