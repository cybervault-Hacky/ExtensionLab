# ExtensionLab disposable sandbox image — Microsoft Edge runtime.
#
# Edge runs the Chromium engine but is a distinct browser with its own
# executable and image; it is never launched through the Chromium executable.
# The container security profile is byte-for-byte the Phase 3/6 profile:
# non-root user, cap-drop ALL, no-new-privileges, read-only root, tmpfs,
# CPU/memory/PID limits (enforced by the host Docker driver), no privileged
# mode, no host network, no Docker socket.
#
# Version policy: microsoft-edge-stable tracks Microsoft's stable apt channel
# pinned at image build time. Record the deployment version label with
# BROWSER_EDGE_VERSION; the runner detects and reports the exact version per
# execution.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV EXTENSIONLAB_BROWSER=edge

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates \
     curl \
     gnupg \
     xvfb \
     fonts-liberation \
  && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > /usr/share/keyrings/microsoft.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/edge stable main" > /etc/apt/sources.list.d/microsoft-edge.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends microsoft-edge-stable \
  && apt-get purge -y gnupg \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

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
