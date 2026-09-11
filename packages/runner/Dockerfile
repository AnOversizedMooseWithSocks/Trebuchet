# Sealed launch runner image.
#
# Deliberately minimal: the runner never sees the desktop app, the web
# renderer, or any secret store. State lives in /tmp (ephemeral on Fly
# machines); the bearer token arrives via fly secrets at boot.

FROM node:22-slim

WORKDIR /app

# Core package (source only) and the runner itself.
COPY packages/core/package.json ./core/package.json
COPY packages/core/src ./core/src
COPY packages/runner/package.json /tmp/runner-package.json
COPY packages/runner/src ./src

# Outside a workspace, point the Core dependency at the vendored copy.
RUN sed 's|"@trebuchet/core": "[^"]*"|"@trebuchet/core": "file:./core"|' /tmp/runner-package.json > package.json \
  && npm install --omit=dev --no-audit --no-fund

# Unprivileged runtime user; packet state lives under /tmp.
RUN useradd --system --create-home runner \
  && mkdir -p /tmp/trebuchet-runner \
  && chown -R runner:runner /tmp/trebuchet-runner

USER runner
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/server.mjs"]