# A Sigil node: the same site and API, in one container, with its data in /data.
#
#   docker compose up -d --build        (see compose.yaml and README, "Run your own node")
#
# The content security policy is fixed when the site is built, so the addresses
# it lists (the public address, extra storage addresses, public chain read
# addresses) are build arguments. Everything else is read at start.

FROM node:22.13-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Only what the site needs: the core package and the web workspace.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY web/package.json web/
RUN npm ci --workspace @sigil/web --workspace @sigil/core --include-workspace-root --no-audit --no-fund
COPY packages/core packages/core
COPY web web
COPY docs/spec docs/spec
ARG NEXT_PUBLIC_SITE_URL=
ARG SIGIL_ORIGIN=
ARG SIGIL_BACKUP_ORIGINS=
ARG SIGIL_CHAIN_READ_RPC=
ARG SIGIL_IDENTITY_READ_RPC=
ARG NEXT_PUBLIC_SIGIL_TOKEN=
ARG NEXT_PUBLIC_SIGIL_TOKEN_SYMBOL=
RUN npm run build -w @sigil/web && npm prune --omit=dev --workspace @sigil/web --workspace @sigil/core --include-workspace-root

FROM node:22.13-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    SIGIL_DATA_DIR=/data
RUN useradd --system --uid 10001 --home-dir /data sigil && mkdir -p /data && chown sigil:sigil /data
COPY --from=build --chown=sigil:sigil /app /app
USER sigil
EXPOSE 3000
# The node's own health endpoint; it answers without touching any vault.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# The server runs as the container's own process, not under npm and a shell, so
# a stop signal (an update, a restart) reaches it: it stops taking requests,
# answers the ones already running and closes the database cleanly. The port
# comes from PORT. The working folder is the site's, as with npm start.
WORKDIR /app/web
STOPSIGNAL SIGTERM
CMD ["node", "../node_modules/next/dist/bin/next", "start"]
