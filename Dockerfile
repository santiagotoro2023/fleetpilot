# FleetPilot as a container: the app server (Node.js) serves the web app and the API
# and keeps all data in PostgreSQL. The container itself holds no data: any number
# of replicas, no volume.
#
#   docker build -t fleetpilot .
#   docker compose up -d          the app with a PostgreSQL database, see docker-compose.yml
#
# Settings (environment variables):
#   FLEETPILOT_DATABASE_URL   postgres://user:password@host:5432/fleetpilot (required)
#   FLEETPILOT_CANONICAL      the public address, e.g. https://fleetpilot.example.com
#   FLEETPILOT_PORT           port inside the container, default 8080
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine
ARG VERSION=dev
# System packages the app server needs (APP_PACKAGES in project.conf)
RUN apk add --no-cache ansible-core openssh-client
LABEL org.opencontainers.image.title="FleetPilot" \
      org.opencontainers.image.description="Inventory, IP address management and intent-based automation with Ansible: take over new hosts, describe their desired state and apply it to the whole fleet." \
      org.opencontainers.image.source="https://github.com/santiagotoro2023/fleetpilot" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production \
    FLEETPILOT_VERSION="${VERSION}" \
    FLEETPILOT_PORT=8080 \
    FLEETPILOT_WEB_DIR=/app/web \
    FLEETPILOT_CANONICAL=""

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/
COPY src/ ./web/
RUN rm -f web/site.json web/package.json && chmod -R a+rX /app
# The key for the stored secrets: a volume here (Compose), or FLEETPILOT_SECRET_KEY (Kubernetes)
RUN mkdir -p /var/lib/fleetpilot && chown node:node /var/lib/fleetpilot && chmod 700 /var/lib/fleetpilot
ENV FLEETPILOT_SECRET_KEY_FILE=/var/lib/fleetpilot/fleetpilot.key
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server/main.mjs"]
