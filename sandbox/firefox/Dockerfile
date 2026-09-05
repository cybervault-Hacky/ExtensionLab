# ExtensionLab disposable sandbox image — Firefox (Gecko) runtime.
#
# Firefox is driven through geckodriver (WebDriver + WebDriver BiDi); no CDP
# assumptions are forced onto it. The container security profile is identical
# to the Chromium image: non-root user, cap-drop ALL, no-new-privileges,
# read-only root filesystem, tmpfs-only writes, resource limits enforced by
# the host Docker driver, no privileged mode, no host network, no Docker
# socket.
#
# Version policy: firefox-esr is pinned by the Debian base at build time;
# geckodriver is pinned by GECKODRIVER_VERSION (optionally verified when
# GECKODRIVER_SHA256 is provided at build time). Record the deployment-level
# version label with BROWSER_FIREFOX_VERSION; the runner detects and reports
# the exact Firefox version per execution.
#
# Build:
#   npm run sandbox:build:firefox
#   docker build -f sandbox/firefox/Dockerfile --build-arg GECKODRIVER_VERSION=0.36.0 \
#     --build-arg GECKODRIVER_SHA256=<sha256> -t extensionlab-sandbox-firefox:local .

FROM node:22-bookworm-slim

ARG GECKODRIVER_VERSION=0.36.0
ARG GECKODRIVER_SHA256=

ENV DEBIAN_FRONTEND=noninteractive
ENV EXTENSIONLAB_BROWSER=firefox

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     firefox-esr \
     xvfb \
     fonts-liberation \
     ca-certificates \
     curl \
     bzip2 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /tmp/geckodriver.tar.gz \
     "https://github.com/mozilla/geckodriver/releases/download/v${GECKODRIVER_VERSION}/geckodriver-v${GECKODRIVER_VERSION}-linux64.tar.gz" \
  && if [ -n "${GECKODRIVER_SHA256}" ]; then \
       echo "${GECKODRIVER_SHA256}  /tmp/geckodriver.tar.gz" | sha256sum -c - || exit 1; \
     fi \
  && tar -xzf /tmp/geckodriver.tar.gz -C /usr/local/bin geckodriver \
  && chmod 755 /usr/local/bin/geckodriver \
  && rm -f /tmp/geckodriver.tar.gz \
  && apt-get purge -y curl bzip2 \
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
