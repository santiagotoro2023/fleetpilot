# Deploying FleetPilot

<!-- Written by the blueprint (1.1.1) from project.conf: do not edit, run build.sh. -->

FleetPilot is a web app with an app server (Node.js) and a **PostgreSQL** database.
The app server serves the web app and its API and keeps **all data in PostgreSQL**:
the app containers themselves hold nothing, so they can be replaced, updated and scaled
freely. What needs care is the database: where it runs, and its backups.

| Way | Good for | Where |
|---|---|---|
| Installer script | One Debian 12/13 server: PostgreSQL, HTTPS, Let's Encrypt and backups included | [`fleetpilot-install.sh`](../fleetpilot-install.sh), see the README |
| Docker | One host with Docker | [Docker](#docker) |
| Docker Compose | One host, with or without automatic HTTPS | [`docker-compose.yml`](../docker-compose.yml), [`deploy/compose/https`](../deploy/compose/https) |
| Kubernetes manifests | A cluster, one `kubectl apply` | [`deploy/kubernetes/fleetpilot.yaml`](../deploy/kubernetes/fleetpilot.yaml) |
| Helm chart | A cluster, configurable, easy upgrades | [`deploy/helm/fleetpilot`](../deploy/helm/fleetpilot) |

Before you go to production, read [The database](#the-database) and [Backups](#backups).

---

## The image

```
ghcr.io/santiagotoro2023/fleetpilot:1.0.0      a fixed version (recommended)
ghcr.io/santiagotoro2023/fleetpilot:latest     the newest version from main
```

- Built for **linux/amd64 and linux/arm64** (Raspberry Pi 4/5, Ampere, Apple Silicon hosts).
- Based on `node:22-alpine`: runs as **user 1000 (node), not root**, listens on
  **port 8080**, works with a **read-only root file system** (it only writes to `/tmp`).
- At start the app server brings the database schema up to date (migrations, safe with
  any number of replicas starting at the same time).
- `GET /healthz` answers `ok` for health checks once the app server runs and reaches the database.
- The GitHub workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml)
  tests everything and builds and publishes the image and the Helm chart for every push to `main`.

> **First time only:** packages on GitHub start out private. Make the image public under
> *GitHub → your profile → Packages → fleetpilot → Package settings → Change visibility*,
> and the same for `charts/fleetpilot`. Or keep it private and give the cluster an
> `imagePullSecret` (see [Troubleshooting](#troubleshooting)).

Build it yourself instead:

```bash
docker build -t fleetpilot --build-arg VERSION=$(cat VERSION) .
# for both architectures and straight into your registry:
docker buildx build --platform linux/amd64,linux/arm64 --build-arg VERSION=$(cat VERSION) \
  -t registry.example.com/fleetpilot:$(cat VERSION) --push .
```

### Settings

| Environment variable | Meaning |
|---|---|
| `FLEETPILOT_DATABASE_URL` | **Required.** `postgres://user:password@host:5432/database` |
| `FLEETPILOT_CANONICAL` | The public address, e.g. `https://fleetpilot.example.com` (no path). Share links point there. A browser that opens FleetPilot under a **different** address gets a card offering to move its data there. Leave empty when there is only one address. |
| `FLEETPILOT_PORT` | Port inside the container, default `8080`. |
| `FLEETPILOT_LOG_LEVEL` | `info` (default), `warn`, `error` or `debug`. Logs go to stdout, one JSON object per line. |
| `FLEETPILOT_SECRET_KEY` | The key that encrypts the stored secrets: 32 random bytes in base64 (`openssl rand -base64 32`). See "The key for the stored secrets" below. |
| `FLEETPILOT_SECRET_KEY_FILE` | Instead: a file with the key. The image sets `/var/lib/fleetpilot/fleetpilot.key`; it is created on the first start when it is missing and nothing is encrypted yet. |
| `FLEETPILOT_SECRET_KEY_PREVIOUS` | Only while changing the key: the old one. |
| `FLEETPILOT_SETUP_CODE` | The setup code of the first administrator. Empty (the default): made once and shown in the log. |

---

## Docker

```bash
docker run -d --name fleetpilot --restart unless-stopped \
  -p 8080:8080 \
  -e FLEETPILOT_DATABASE_URL=postgres://fleetpilot:secret@db.example.com:5432/fleetpilot \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/santiagotoro2023/fleetpilot:1.0.0
```

Without a PostgreSQL server of your own, use Docker Compose: it brings one along.

Open `http://<host>:8080`. The container speaks plain HTTP; put a reverse proxy with TLS in
front for anything beyond a lab network (see the Compose example with Caddy).

---

## Docker Compose

**Quick start** (in the repository root):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env    # once
docker compose up -d            # pulls the image
docker compose up -d --build    # or builds it from this checkout
```

**With HTTPS and a domain name** (Caddy gets and renews the Let's Encrypt certificate):

```bash
cd deploy/compose/https
cp .env.example .env            # set FLEETPILOT_DOMAIN=fleetpilot.example.com
                                # and POSTGRES_PASSWORD
docker compose up -d
```

Needs a DNS record pointing to the host, and ports 80 and 443 reachable from the internet.
The data is in the Docker volume `db`. `docker compose down` keeps it, `docker compose down -v`
deletes it.

---

## Kubernetes

Tested shape: a small cluster with **three nodes** (k3s, kubeadm, RKE2, managed clusters).
FleetPilot runs **3 replicas, one per node** (topology spread), with a
**PodDisruptionBudget** so that draining a node or upgrading never takes it offline, and
**rolling updates without downtime** (`maxUnavailable: 0`).

What you need:

- An **ingress controller**. k3s ships with Traefik (`ingressClassName: traefik`), many
  other clusters use ingress-nginx (`ingressClassName: nginx`).
- For HTTPS, optionally **cert-manager** with a `ClusterIssuer` (here called `letsencrypt`).
  Or a TLS secret you create yourself.
- A DNS name pointing at the ingress (or at your nodes / load balancer).
- For the bundled database: a default **StorageClass** (k3s: `local-path`, managed
  clusters have one), or set `database.bundled.storageClass`.

### Option 1: one manifest

```bash
# edit host name, ingressClassName and FLEETPILOT_CANONICAL in the file first
# and the database password (two places in the Secret)
kubectl apply -f deploy/kubernetes/fleetpilot.yaml
kubectl -n fleetpilot get pods -o wide        # three pods on three nodes
```

Without an ingress, try it with `kubectl -n fleetpilot port-forward svc/fleetpilot 8080:80`.

### Option 2: Helm (recommended)

Install straight from the registry:

```bash
helm install fleetpilot oci://ghcr.io/santiagotoro2023/charts/fleetpilot \
  --version 1.0.0 --namespace fleetpilot --create-namespace \
  -f my-values.yaml
```

or from this repository: `helm install fleetpilot deploy/helm/fleetpilot -n fleetpilot --create-namespace -f my-values.yaml`.

Example `my-values.yaml` for **k3s with Traefik and cert-manager**:

```yaml
ingress:
  enabled: true
  className: traefik
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: fleetpilot.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: fleetpilot-tls
      hosts: [fleetpilot.example.com]
# canonicalUrl is taken from the first host (https because of tls); set it to override
```

Without an ingress, reachable on every node at port 30080:

```yaml
service:
  type: NodePort
  nodePort: 30080
```

With MetalLB or a cloud load balancer: `service.type: LoadBalancer`.

Check it:

```bash
kubectl -n fleetpilot get pods -o wide
helm test fleetpilot -n fleetpilot          # calls /healthz and /site.json through the service
```

Important values (all of them are in [`values.yaml`](../deploy/helm/fleetpilot/values.yaml)):

| Value | Default | Meaning |
|---|---|---|
| `replicaCount` | `3` | Pods (ignored with autoscaling) |
| `image.repository` / `image.tag` | ghcr.io/santiagotoro2023/fleetpilot / chart version | Image |
| `canonicalUrl` | from the ingress | Public address (see `FLEETPILOT_CANONICAL`) |
| `ingress.*` | off | Host, class, TLS, annotations |
| `service.type` / `service.nodePort` | `ClusterIP` | NodePort or LoadBalancer without an ingress |
| `podDisruptionBudget.maxUnavailable` | `1` | At most one pod down during maintenance |
| `topologySpread.enabled` | `true` | Spread pods over nodes and zones |
| `autoscaling.enabled` | `false` | HPA between `minReplicas` and `maxReplicas` |
| `networkPolicy.enabled` | `false` | Only the ingress namespace may connect, egress only to PostgreSQL and DNS |
| `database.bundled.enabled` | `true` | A PostgreSQL pod with a volume inside the release |
| `database.bundled.storage` | `5Gi` | Size of its volume |
| `database.password` | generated | Password of the bundled database, kept across upgrades |
| `database.url` / `database.existingSecret` | empty | An external PostgreSQL instead |
| `resources` | see values.yaml | Requests and limits |

### Updating

```bash
helm upgrade fleetpilot oci://ghcr.io/santiagotoro2023/charts/fleetpilot --version <new> -n fleetpilot -f my-values.yaml
# or with the manifest: change the image tag and kubectl apply again
```

Pods are replaced one at a time; the site stays up.
The first new pod migrates the database; old pods keep working during the rollout because
migrations only ever add (see the blueprint's backend rules). **Back up before every update.**

---

## The database

FleetPilot needs **PostgreSQL 15 or newer** and one database that belongs to it.

| Deployment | Database | Where the data is |
|---|---|---|
| Installer | Local PostgreSQL from Debian, created by the installer (peer authentication, no password) | `/var/lib/postgresql` |
| Installer with `--database-url` | Your PostgreSQL server | there |
| Compose | `postgres:17-alpine` service `db` | Docker volume `db` |
| Kubernetes manifest | StatefulSet `db` | PersistentVolumeClaim `data-db-0` |
| Helm | bundled StatefulSet `<release>-fleetpilot-db`, or `database.url` | its PVC, or your server |

For important data, run PostgreSQL separately (a managed database, or one maintained by
someone) and give FleetPilot its URL. The bundled databases are meant for a start and for
small installations.

## Backups

| Deployment | Back up | Restore |
|---|---|---|
| Installer | Automatic: daily and before every update, the last 14 in `/var/backups/fleetpilot`. Now: `sudo bash /opt/fleetpilot/fleetpilot-install.sh --backup` | `--restore <file>` (backs up the current state first) |
| Compose | `docker compose exec -T db pg_dump -U fleetpilot -Fc fleetpilot > fleetpilot-$(date +%F).dump` | `docker compose exec -T db pg_restore -U fleetpilot -d fleetpilot --clean --if-exists < file.dump` |
| Kubernetes / Helm (bundled) | `kubectl -n fleetpilot exec <db-pod> -- pg_dump -U fleetpilot -Fc fleetpilot > fleetpilot-$(date +%F).dump` | `kubectl -n fleetpilot exec -i <db-pod> -- pg_restore -U fleetpilot -d fleetpilot --clean --if-exists < file.dump` |
| External database | With the tools of your database service | the same |

All backups are `pg_dump` custom format files: a backup from any deployment can be restored
into any other. That is also how you **move** FleetPilot (installer → Kubernetes, for
example): back up on the old one, restore on the new one, then switch the DNS name.

## The key for the stored secrets

Passwords, keys and tokens that FleetPilot keeps for you are encrypted in the database with a
key that is **not** in the database. A stolen database or backup is useless without it, and so is
your own backup: **back the key up apart from the database backups**, and keep it as safe as
the systems the secrets open.

| Deployment | Where the key is | Back it up |
|---|---|---|
| Installer | `/var/lib/fleetpilot/fleetpilot.key`, made by the first install, kept by updates and `--uninstall` | `sudo cat /var/lib/fleetpilot/fleetpilot.key` |
| Compose | volume `keys`, made on the first start | `docker compose cp fleetpilot:/var/lib/fleetpilot/fleetpilot.key .` |
| Helm | Secret `<release>-fleetpilot-key`, generated at the first install, never deleted by `helm uninstall` (or `secretKey.existingSecret`) | `kubectl get secret <release>-fleetpilot-key -o jsonpath='{.data.key}' \| base64 -d` |
| Kubernetes manifest | Secret `fleetpilot-key`: put a key in before the first apply | from where you made it |

**Moving** to another deployment: restore the database backup and give the new deployment the
same key (`FLEETPILOT_SECRET_KEY`, or the key file). With a different key the app does not start
and says so: it never makes the stored secrets unreadable by accident.

**Changing the key:** start with the new key as `FLEETPILOT_SECRET_KEY` and the old one as
`FLEETPILOT_SECRET_KEY_PREVIOUS`; once FleetPilot has encrypted everything again, remove the old one.

## The first administrator

A new FleetPilot has no accounts. Open it in the browser and create the first administrator with
the **setup code**. The code is in the log of the app server until the first account exists:

| Deployment | The setup code |
|---|---|
| Installer | printed at the end of the install; later: `journalctl -u fleetpilot \| grep setup_code` |
| Compose | `docker compose logs fleetpilot \| grep setup_code` |
| Kubernetes, Helm | `kubectl -n <namespace> logs deploy/<name> \| grep setup_code` |

Further accounts are added by administrators in the app. A forgotten password is reset by an
administrator; a lost phone (two-factor sign-in) as well.


---

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `ImagePullBackOff` | The package on GitHub is still private. Make it public, or create a pull secret: `kubectl -n fleetpilot create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=<user> --docker-password=<token with read:packages>` and set `imagePullSecrets: [{name: ghcr}]`. |
| Ingress answers 404 | Wrong `ingressClassName` (k3s: `traefik`, ingress-nginx: `nginx`). `kubectl get ingressclass` lists them. |
| Pods not spread over the nodes | The spread is a preference (`ScheduleAnyway`). With fewer schedulable nodes than replicas some share a node. Set `topologySpread.whenUnsatisfiable: DoNotSchedule` to enforce it. |
| The card "FleetPilot has a new address" appears unexpectedly | `FLEETPILOT_CANONICAL` / `canonicalUrl` is not the address you open. Set it to the real public address, or leave it empty. On the installer: `--no-move-card`. |
| The pod crashes with "Read-only file system" | `/tmp` needs to be writable: the chart and the manifest mount an `emptyDir` there; keep it when you write your own manifests. |
| IPv6-only or IPv4-only cluster | Nothing to do: the container listens on IPv6 only where the kernel has it. |
| The pod restarts, the log says it cannot reach the database | Wrong `FLEETPILOT_DATABASE_URL`, the database is not up yet (it retries for a minute), or a NetworkPolicy blocks port 5432. |
| "The database is newer than this version" | The database was used by a newer FleetPilot (or a newer backup was restored). Run that version again; never downgrade over a migrated database. |
| Bundled database pod stays `Pending` | No default StorageClass: set `database.bundled.storageClass`. |
| "The key for the stored secrets … is not the key they were encrypted with" | The app got another key than the one it used before (a new volume, a new Secret, another server). Give it the right key; see "The key for the stored secrets". |
| "No key for the stored secrets" | Set `FLEETPILOT_SECRET_KEY` (or `FLEETPILOT_SECRET_KEY_FILE`). |

---

## Security notes

- The containers run as unprivileged users without capabilities, the app read-only and
  without a service account token; the pods meet the Kubernetes `restricted` Pod Security level.
- The app server sends a strict Content Security Policy (`default-src 'self'`), `nosniff`,
  `X-Frame-Options` and no referrer, the same in every deployment.
- On the installer the service runs as its own system user, sandboxed by systemd, and
  reaches the local database through its Unix socket without a password.
- Database passwords live in the environment file (`/opt/fleetpilot/fleetpilot.env`, mode 640),
  in Docker's `.env`, or in a Kubernetes Secret: never in the repository or the image.
- Sign-in: passwords hashed with scrypt, sessions in an `HttpOnly` cookie (`Secure` over HTTPS),
  lockout after wrong passwords, two-factor sign-in with an authenticator app. Put
  FleetPilot behind HTTPS (the installer does by default).
- Stored secrets are encrypted with AES-256-GCM; the key is kept apart from the database.
