# 5. Deployment and release

Every app runs the same four ways, from the same files, documented by the same
`docs/DEPLOYMENT.md`: the Debian installer (04-installer.md), Docker, Docker Compose, and
Kubernetes with a single manifest or a Helm chart. All of it is written by the blueprint; an app
changes none of it.

## 5.1 The container image

| | Static profile | Server profile |
|---|---|---|
| Base | `nginxinc/nginx-unprivileged:1.27-alpine` | `node:22-alpine` (dependencies in a separate build stage) |
| User | 101 | 1000 (`node`) |
| Port | 8080 (`<ID>_PORT`) | 8080 (`<ID>_PORT`) |
| Root file system | read-only, writes only to `/tmp` | read-only, writes only to `/tmp` |
| Health | `GET /healthz` → `ok` | `GET /healthz` → `ok` when the database answers, else 503 |
| site.json | written at start from `<ID>_CANONICAL` | answered by the app server from `<ID>_CANONICAL` |
| State | none | none: all data in PostgreSQL |
| Platforms | linux/amd64, linux/arm64 | linux/amd64, linux/arm64 |

Labels follow OCI (`org.opencontainers.image.*`) with title, description, source and version.
IPv6 is used only where the kernel has it.

## 5.2 Environment variables

All of them start with `<ID>_` (the `APP_ID` in capitals, dashes as underscores). Apps add their
own the same way and document them in `docs/` (never secrets in the image or repository).

| Variable | Profile | Meaning |
|---|---|---|
| `<ID>_CANONICAL` | both | the public address, e.g. `https://myapp.example.com` (no path) |
| `<ID>_PORT` | both | port inside the container, default 8080 |
| `<ID>_VERSION` | both | set by the image |
| `<ID>_DATABASE_URL` | server | `postgres://user:password@host:5432/db`, required |
| `<ID>_HOST` | server | listen address, default all |
| `<ID>_WEB_DIR` | server | where the web app is, set by the image and the installer |
| `<ID>_LOG_LEVEL` | server | `debug`, `info` (default), `warn`, `error` |
| `<ID>_SECRET_KEY`, `<ID>_SECRET_KEY_FILE`, `<ID>_SECRET_KEY_PREVIOUS` | server, element `secrets` | the key for the stored secrets (installer: a file in `/var/lib/<id>/`, Compose: volume `keys`, Helm: a kept Secret) |
| `<ID>_SETUP_CODE` | server, element `auth` | the setup code of the first administrator (default: made once, in the log) |

## 5.3 Docker Compose

- `docker-compose.yml`: the app (and in the server profile `postgres:17-alpine` with a volume
  `db` and a health check), port 8080, read-only, no capabilities, no new privileges.
- `deploy/compose/https/`: the same behind Caddy, which gets and renews a Let's Encrypt certificate;
  the domain (and the database password) come from `.env`.

## 5.4 Kubernetes

- `deploy/kubernetes/<id>.yaml`: namespace (Pod Security `restricted`), Deployment with 3
  replicas, topology spread over nodes, rolling updates without downtime (`maxUnavailable: 0`),
  PodDisruptionBudget, Service, Ingress (cert-manager annotation), probes on `/healthz`, `/tmp` as
  `emptyDir`. Server profile: a Secret with the database URL and a small PostgreSQL StatefulSet with
  a volume.
- `deploy/helm/<id>/`: the same, configurable: `replicaCount`, `image`, `canonicalUrl` (or from
  the first Ingress host), `ingress`, `service` (ClusterIP, NodePort, LoadBalancer),
  `podDisruptionBudget`, `topologySpread`, `autoscaling` (HPA), `networkPolicy`, `resources`, and in
  the server profile `database` (bundled PostgreSQL with a generated password that survives
  upgrades and a Secret that `helm uninstall` keeps, or `url`, or `existingSecret`),
  `networkPolicy.extraEgress` (more connections the app may open), and with the element `secrets`
  `secretKey` (a generated key in a Secret that `helm uninstall` keeps, or `existingSecret`). `helm test`
  calls `/healthz` and `/site.json`. The bundled database's pods carry their own name label so the
  app's selectors never match them.
- Labels and selectors never change between versions: upgrades must work with `helm upgrade`.

## 5.5 The pipeline (`.github/workflows/release.yml`)

On every push and pull request:

| Job | What |
|---|---|
| test | `npm ci`, `blueprint check`, `build.sh` with nothing left to commit, unit tests, browser tests (Chromium), `helm lint --strict`, `helm template` and the manifest validated by kubeconform for Kubernetes 1.31. Server profile: a PostgreSQL 17 service for the tests |
| compose | `docker compose up --build --wait`, `/healthz`, `/site.json`, the page, `down -v` |
| installer | the installer on Debian 12 and 13 with systemd: install, options, update from the previous release, uninstall; server profile also backup, restore, purge |

On pushes to `main` and tags `v*`, after all of them passed:

| Job | What |
|---|---|
| image | multi-arch image to `ghcr.io/<owner>/<id>:<version>`, `:latest`, `:sha-…` |
| chart | `helm package` and push to `oci://ghcr.io/<owner>/charts/<id>` |

The first time, the packages on GitHub are private: make the image and the chart public in the
package settings (or give clusters a pull secret). The README and DEPLOYMENT.md say so.

## 5.6 Releasing

1. Raise `VERSION` (3.5), `bash build.sh`, run all tests, commit, push to `main`.
2. The pipeline publishes image and chart with that version.
3. Servers with the installer update with `--update`; clusters with `helm upgrade --version <new>`;
   Compose with `docker compose pull && docker compose up -d`.

## 5.7 Hosting choices

- One machine, few users: the installer.
- One machine with Docker already in use: Compose (with HTTPS through Caddy).
- A cluster (k3s on three nodes is the reference shape): Helm.
- Server profile with important data: PostgreSQL run and backed up separately (a managed database
  or one looked after by someone), the app pointed at it (`--database-url`, `database.url`).
