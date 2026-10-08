# Deploying @@APP_NAME@@

<!-- Written by the blueprint (@@BLUEPRINT_VERSION@@) from project.conf: do not edit, run build.sh. -->

@@IF static@@
@@APP_NAME@@ is a static web app: nginx serves HTML, CSS and JavaScript, and everything
else runs in the browser. **Nothing is stored on the server.** Every user's data lives in
their own browser. That makes every deployment simple: no database, no volume, any number
of replicas.
@@END@@
@@IF server@@
@@APP_NAME@@ is a web app with an app server (Node.js) and a **PostgreSQL** database.
The app server serves the web app and its API and keeps **all data in PostgreSQL**:
the app containers themselves hold nothing, so they can be replaced, updated and scaled
freely. What needs care is the database: where it runs, and its backups.
@@END@@

| Way | Good for | Where |
|---|---|---|
@@IF static@@
| Installer script | One Debian 12/13 server, HTTPS and Let's Encrypt included | [`@@APP_ID@@-install.sh`](../@@APP_ID@@-install.sh), see the README |
@@END@@
@@IF server@@
| Installer script | One Debian 12/13 server: PostgreSQL, HTTPS, Let's Encrypt and backups included | [`@@APP_ID@@-install.sh`](../@@APP_ID@@-install.sh), see the README |
@@END@@
| Docker | One host with Docker | [Docker](#docker) |
| Docker Compose | One host, with or without automatic HTTPS | [`docker-compose.yml`](../docker-compose.yml), [`deploy/compose/https`](../deploy/compose/https) |
| Kubernetes manifests | A cluster, one `kubectl apply` | [`deploy/kubernetes/@@APP_ID@@.yaml`](../deploy/kubernetes/@@APP_ID@@.yaml) |
| Helm chart | A cluster, configurable, easy upgrades | [`deploy/helm/@@APP_ID@@`](../deploy/helm/@@APP_ID@@) |

@@IF static@@
Before you move users from one server to another, read
[Moving users and their data](#moving-users-and-their-data).
@@END@@
@@IF server@@
Before you go to production, read [The database](#the-database) and [Backups](#backups).
@@END@@

---

## The image

```
ghcr.io/@@APP_OWNER_LC@@/@@APP_ID@@:@@VERSION@@      a fixed version (recommended)
ghcr.io/@@APP_OWNER_LC@@/@@APP_ID@@:latest     the newest version from main
```

- Built for **linux/amd64 and linux/arm64** (Raspberry Pi 4/5, Ampere, Apple Silicon hosts).
@@IF static@@
- Based on `nginxinc/nginx-unprivileged` (Alpine): runs as **user 101, not root**, listens
  on **port 8080**, works with a **read-only root file system** (it only writes to `/tmp`).
@@END@@
@@IF server@@
- Based on `node:22-alpine`: runs as **user 1000 (node), not root**, listens on
  **port 8080**, works with a **read-only root file system** (it only writes to `/tmp`).
- At start the app server brings the database schema up to date (migrations, safe with
  any number of replicas starting at the same time).
@@END@@
@@IF static@@
- `GET /healthz` answers `ok` for health checks.
@@END@@
@@IF server@@
- `GET /healthz` answers `ok` for health checks once the app server runs and reaches the database.
@@END@@
- The GitHub workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml)
  tests everything and builds and publishes the image and the Helm chart for every push to `main`.

> **First time only:** packages on GitHub start out private. Make the image public under
> *GitHub → your profile → Packages → @@APP_ID@@ → Package settings → Change visibility*,
> and the same for `charts/@@APP_ID@@`. Or keep it private and give the cluster an
> `imagePullSecret` (see [Troubleshooting](#troubleshooting)).

Build it yourself instead:

```bash
docker build -t @@APP_ID@@ --build-arg VERSION=$(cat VERSION) .
# for both architectures and straight into your registry:
docker buildx build --platform linux/amd64,linux/arm64 --build-arg VERSION=$(cat VERSION) \
  -t registry.example.com/@@APP_ID@@:$(cat VERSION) --push .
```

### Settings

| Environment variable | Meaning |
|---|---|
@@IF server@@
| `@@APP_ENV@@_DATABASE_URL` | **Required.** `postgres://user:password@host:5432/database` |
@@END@@
| `@@APP_ENV@@_CANONICAL` | The public address, e.g. `https://@@APP_ID@@.example.com` (no path). Share links point there. A browser that opens @@APP_NAME@@ under a **different** address gets a card offering to move its data there. Leave empty when there is only one address. |
| `@@APP_ENV@@_PORT` | Port inside the container, default `8080`. |
@@IF server@@
| `@@APP_ENV@@_LOG_LEVEL` | `info` (default), `warn`, `error` or `debug`. Logs go to stdout, one JSON object per line. |
@@END@@
@@IF lib:secrets@@
| `@@APP_ENV@@_SECRET_KEY` | The key that encrypts the stored secrets: 32 random bytes in base64 (`openssl rand -base64 32`). See "The key for the stored secrets" below. |
| `@@APP_ENV@@_SECRET_KEY_FILE` | Instead: a file with the key. The image sets `/var/lib/@@APP_ID@@/@@APP_ID@@.key`; it is created on the first start when it is missing and nothing is encrypted yet. |
| `@@APP_ENV@@_SECRET_KEY_PREVIOUS` | Only while changing the key: the old one. |
@@END@@
@@IF lib:auth@@
| `@@APP_ENV@@_SETUP_CODE` | The setup code of the first administrator. Empty (the default): made once and shown in the log. |
@@END@@

---

## Docker

@@IF static@@
```bash
docker run -d --name @@APP_ID@@ --restart unless-stopped \
  -p 8080:8080 \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/@@APP_OWNER_LC@@/@@APP_ID@@:@@VERSION@@
```
@@END@@
@@IF server@@
```bash
docker run -d --name @@APP_ID@@ --restart unless-stopped \
  -p 8080:8080 \
  -e @@APP_ENV@@_DATABASE_URL=postgres://@@APP_ID@@:secret@db.example.com:5432/@@APP_ID@@ \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/@@APP_OWNER_LC@@/@@APP_ID@@:@@VERSION@@
```

Without a PostgreSQL server of your own, use Docker Compose: it brings one along.
@@END@@

Open `http://<host>:8080`. The container speaks plain HTTP; put a reverse proxy with TLS in
front for anything beyond a lab network (see the Compose example with Caddy).

---

## Docker Compose

**Quick start** (in the repository root):

```bash
@@IF server@@
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > .env    # once
@@END@@
docker compose up -d            # pulls the image
docker compose up -d --build    # or builds it from this checkout
```

**With HTTPS and a domain name** (Caddy gets and renews the Let's Encrypt certificate):

```bash
cd deploy/compose/https
cp .env.example .env            # set @@APP_ENV@@_DOMAIN=@@APP_ID@@.example.com
@@IF server@@
                                # and POSTGRES_PASSWORD
@@END@@
docker compose up -d
```

Needs a DNS record pointing to the host, and ports 80 and 443 reachable from the internet.
@@IF server@@
The data is in the Docker volume `db`. `docker compose down` keeps it, `docker compose down -v`
deletes it.
@@END@@

---

## Kubernetes

Tested shape: a small cluster with **three nodes** (k3s, kubeadm, RKE2, managed clusters).
@@APP_NAME@@ runs **3 replicas, one per node** (topology spread), with a
**PodDisruptionBudget** so that draining a node or upgrading never takes it offline, and
**rolling updates without downtime** (`maxUnavailable: 0`).

What you need:

- An **ingress controller**. k3s ships with Traefik (`ingressClassName: traefik`), many
  other clusters use ingress-nginx (`ingressClassName: nginx`).
- For HTTPS, optionally **cert-manager** with a `ClusterIssuer` (here called `letsencrypt`).
  Or a TLS secret you create yourself.
- A DNS name pointing at the ingress (or at your nodes / load balancer).
@@IF server@@
- For the bundled database: a default **StorageClass** (k3s: `local-path`, managed
  clusters have one), or set `database.bundled.storageClass`.
@@END@@

### Option 1: one manifest

```bash
# edit host name, ingressClassName and @@APP_ENV@@_CANONICAL in the file first
@@IF server@@
# and the database password (two places in the Secret)
@@END@@
kubectl apply -f deploy/kubernetes/@@APP_ID@@.yaml
kubectl -n @@APP_ID@@ get pods -o wide        # three pods on three nodes
```

Without an ingress, try it with `kubectl -n @@APP_ID@@ port-forward svc/@@APP_ID@@ 8080:80`.

### Option 2: Helm (recommended)

Install straight from the registry:

```bash
helm install @@APP_ID@@ oci://ghcr.io/@@APP_OWNER_LC@@/charts/@@APP_ID@@ \
  --version @@VERSION@@ --namespace @@APP_ID@@ --create-namespace \
  -f my-values.yaml
```

or from this repository: `helm install @@APP_ID@@ deploy/helm/@@APP_ID@@ -n @@APP_ID@@ --create-namespace -f my-values.yaml`.

Example `my-values.yaml` for **k3s with Traefik and cert-manager**:

```yaml
ingress:
  enabled: true
  className: traefik
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: @@APP_ID@@.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: @@APP_ID@@-tls
      hosts: [@@APP_ID@@.example.com]
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
kubectl -n @@APP_ID@@ get pods -o wide
helm test @@APP_ID@@ -n @@APP_ID@@          # calls /healthz and /site.json through the service
```

Important values (all of them are in [`values.yaml`](../deploy/helm/@@APP_ID@@/values.yaml)):

| Value | Default | Meaning |
|---|---|---|
| `replicaCount` | `3` | Pods (ignored with autoscaling) |
| `image.repository` / `image.tag` | ghcr.io/@@APP_OWNER_LC@@/@@APP_ID@@ / chart version | Image |
| `canonicalUrl` | from the ingress | Public address (see `@@APP_ENV@@_CANONICAL`) |
| `ingress.*` | off | Host, class, TLS, annotations |
| `service.type` / `service.nodePort` | `ClusterIP` | NodePort or LoadBalancer without an ingress |
| `podDisruptionBudget.maxUnavailable` | `1` | At most one pod down during maintenance |
| `topologySpread.enabled` | `true` | Spread pods over nodes and zones |
| `autoscaling.enabled` | `false` | HPA between `minReplicas` and `maxReplicas` |
@@IF static@@
| `networkPolicy.enabled` | `false` | Only the ingress namespace may connect, no egress |
@@END@@
@@IF server@@
| `networkPolicy.enabled` | `false` | Only the ingress namespace may connect, egress only to PostgreSQL and DNS |
@@END@@
@@IF server@@
| `database.bundled.enabled` | `true` | A PostgreSQL pod with a volume inside the release |
| `database.bundled.storage` | `5Gi` | Size of its volume |
| `database.password` | generated | Password of the bundled database, kept across upgrades |
| `database.url` / `database.existingSecret` | empty | An external PostgreSQL instead |
@@END@@
| `resources` | see values.yaml | Requests and limits |

### Updating

```bash
helm upgrade @@APP_ID@@ oci://ghcr.io/@@APP_OWNER_LC@@/charts/@@APP_ID@@ --version <new> -n @@APP_ID@@ -f my-values.yaml
# or with the manifest: change the image tag and kubectl apply again
```

Pods are replaced one at a time; the site stays up.
@@IF static@@
**Updates never touch the users' data**: it is in their browsers, and every version of
@@APP_NAME@@ reads what older versions saved (the storage format only ever grows).
@@END@@
@@IF server@@
The first new pod migrates the database; old pods keep working during the rollout because
migrations only ever add (see the blueprint's backend rules). **Back up before every update.**

---

## The database

@@APP_NAME@@ needs **PostgreSQL 15 or newer** and one database that belongs to it.

| Deployment | Database | Where the data is |
|---|---|---|
| Installer | Local PostgreSQL from Debian, created by the installer (peer authentication, no password) | `/var/lib/postgresql` |
| Installer with `--database-url` | Your PostgreSQL server | there |
| Compose | `postgres:17-alpine` service `db` | Docker volume `db` |
| Kubernetes manifest | StatefulSet `db` | PersistentVolumeClaim `data-db-0` |
| Helm | bundled StatefulSet `<release>-@@APP_ID@@-db`, or `database.url` | its PVC, or your server |

For important data, run PostgreSQL separately (a managed database, or one maintained by
someone) and give @@APP_NAME@@ its URL. The bundled databases are meant for a start and for
small installations.

## Backups

| Deployment | Back up | Restore |
|---|---|---|
| Installer | Automatic: daily and before every update, the last 14 in `/var/backups/@@APP_ID@@`. Now: `sudo bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --backup` | `--restore <file>` (backs up the current state first) |
| Compose | `docker compose exec -T db pg_dump -U @@APP_ID@@ -Fc @@APP_ID@@ > @@APP_ID@@-$(date +%F).dump` | `docker compose exec -T db pg_restore -U @@APP_ID@@ -d @@APP_ID@@ --clean --if-exists < file.dump` |
| Kubernetes / Helm (bundled) | `kubectl -n @@APP_ID@@ exec <db-pod> -- pg_dump -U @@APP_ID@@ -Fc @@APP_ID@@ > @@APP_ID@@-$(date +%F).dump` | `kubectl -n @@APP_ID@@ exec -i <db-pod> -- pg_restore -U @@APP_ID@@ -d @@APP_ID@@ --clean --if-exists < file.dump` |
| External database | With the tools of your database service | the same |

All backups are `pg_dump` custom format files: a backup from any deployment can be restored
into any other. That is also how you **move** @@APP_NAME@@ (installer → Kubernetes, for
example): back up on the old one, restore on the new one, then switch the DNS name.
@@END@@
@@IF lib:secrets@@

## The key for the stored secrets

Passwords, keys and tokens that @@APP_NAME@@ keeps for you are encrypted in the database with a
key that is **not** in the database. A stolen database or backup is useless without it, and so is
your own backup: **back the key up apart from the database backups**, and keep it as safe as
the systems the secrets open.

| Deployment | Where the key is | Back it up |
|---|---|---|
| Installer | `/var/lib/@@APP_ID@@/@@APP_ID@@.key`, made by the first install, kept by updates and `--uninstall` | `sudo cat /var/lib/@@APP_ID@@/@@APP_ID@@.key` |
| Compose | volume `keys`, made on the first start | `docker compose cp @@APP_ID@@:/var/lib/@@APP_ID@@/@@APP_ID@@.key .` |
| Helm | Secret `<release>-@@APP_ID@@-key`, generated at the first install, never deleted by `helm uninstall` (or `secretKey.existingSecret`) | `kubectl get secret <release>-@@APP_ID@@-key -o jsonpath='{.data.key}' \| base64 -d` |
| Kubernetes manifest | Secret `@@APP_ID@@-key`: put a key in before the first apply | from where you made it |

**Moving** to another deployment: restore the database backup and give the new deployment the
same key (`@@APP_ENV@@_SECRET_KEY`, or the key file). With a different key the app does not start
and says so: it never makes the stored secrets unreadable by accident.

**Changing the key:** start with the new key as `@@APP_ENV@@_SECRET_KEY` and the old one as
`@@APP_ENV@@_SECRET_KEY_PREVIOUS`; once @@APP_NAME@@ has encrypted everything again, remove the old one.
@@END@@
@@IF lib:auth@@

## The first administrator

A new @@APP_NAME@@ has no accounts. Open it in the browser and create the first administrator with
the **setup code**. The code is in the log of the app server until the first account exists:

| Deployment | The setup code |
|---|---|
| Installer | printed at the end of the install; later: `journalctl -u @@APP_ID@@ \| grep setup_code` |
| Compose | `docker compose logs @@APP_ID@@ \| grep setup_code` |
| Kubernetes, Helm | `kubectl -n <namespace> logs deploy/<name> \| grep setup_code` |

Further accounts are added by administrators in the app. A forgotten password is reset by an
administrator; a lost phone (two-factor sign-in) as well.
@@END@@

@@IF static@@
---

## Moving users and their data

Browsers keep data **per address**: `https://@@APP_ID@@.example.com` and
`http://10.0.0.5:8080` are two different places for a browser, even if they show the same
app. That decides what you have to do.

### Same address before and after: nothing to do

If the users keep using the same address, for example you move
`https://@@APP_ID@@.example.com` from the old server to the cluster by changing the DNS
record (scheme, host and port stay the same), **everyone keeps everything automatically**.
This is the easiest way, and the recommended one.

### A new address: one click per user

Keep the old server running for a while and tell it the new address:

```bash
# on the old server (Debian installer)
sudo bash @@APP_ID@@-install.sh --moved-to https://@@APP_ID@@.example.com
```

From then on, everyone who opens the old address sees a card **"@@APP_NAME@@ has a new
address"** with the button **"Move my data there"**. One click takes them to the new
address with everything they have: the data travels compressed inside the link (after
the `#`, so no server ever sees it) and is merged into whatever they already have there.
Clicking twice does no harm. `--not-moved` removes the card again.

If the old server is a container, set `@@APP_ENV@@_CANONICAL` on it to the new address
instead; the effect is the same.

### Backup file: works always, also between browsers and computers

On the **home page**, in the box about the user's data:

1. **Download backup** at the old address. The file contains everything this browser
   keeps for @@APP_NAME@@.
2. **Restore backup** at the new address. Restoring **merges**: nothing that is already
   there gets lost. Restoring twice changes nothing.

### A message you can send to your users

> @@APP_NAME@@ is moving to **https://@@APP_ID@@.example.com**. Your data is stored in
> your browser. When you open the old address, click **"Move my data there"** in the
> card at the bottom, and everything comes along. If you use another browser or computer,
> download a backup on the home page first and restore it at the new address.
@@END@@

---

## Troubleshooting

| Problem | Cause and fix |
|---|---|
| `ImagePullBackOff` | The package on GitHub is still private. Make it public, or create a pull secret: `kubectl -n @@APP_ID@@ create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=<user> --docker-password=<token with read:packages>` and set `imagePullSecrets: [{name: ghcr}]`. |
| Ingress answers 404 | Wrong `ingressClassName` (k3s: `traefik`, ingress-nginx: `nginx`). `kubectl get ingressclass` lists them. |
| Pods not spread over the nodes | The spread is a preference (`ScheduleAnyway`). With fewer schedulable nodes than replicas some share a node. Set `topologySpread.whenUnsatisfiable: DoNotSchedule` to enforce it. |
| The card "@@APP_NAME@@ has a new address" appears unexpectedly | `@@APP_ENV@@_CANONICAL` / `canonicalUrl` is not the address you open. Set it to the real public address, or leave it empty. On the installer: `--no-move-card`. |
| The pod crashes with "Read-only file system" | `/tmp` needs to be writable: the chart and the manifest mount an `emptyDir` there; keep it when you write your own manifests. |
| IPv6-only or IPv4-only cluster | Nothing to do: the container listens on IPv6 only where the kernel has it. |
@@IF server@@
| The pod restarts, the log says it cannot reach the database | Wrong `@@APP_ENV@@_DATABASE_URL`, the database is not up yet (it retries for a minute), or a NetworkPolicy blocks port 5432. |
| "The database is newer than this version" | The database was used by a newer @@APP_NAME@@ (or a newer backup was restored). Run that version again; never downgrade over a migrated database. |
| Bundled database pod stays `Pending` | No default StorageClass: set `database.bundled.storageClass`. |
@@END@@
@@IF lib:secrets@@
| "The key for the stored secrets … is not the key they were encrypted with" | The app got another key than the one it used before (a new volume, a new Secret, another server). Give it the right key; see "The key for the stored secrets". |
| "No key for the stored secrets" | Set `@@APP_ENV@@_SECRET_KEY` (or `@@APP_ENV@@_SECRET_KEY_FILE`). |
@@END@@

---

## Security notes

@@IF static@@
- The container runs as an unprivileged user without capabilities, read-only, without a
  service account token, and the pod meets the Kubernetes `restricted` Pod Security level.
- nginx sends a strict Content Security Policy (`default-src 'self'`), `nosniff`,
  `X-Frame-Options` and no referrer.
- The app never sends user data anywhere: share links and data transfers carry
  the data in the part of the URL after `#`, which browsers do not send to servers.
@@END@@
@@IF server@@
- The containers run as unprivileged users without capabilities, the app read-only and
  without a service account token; the pods meet the Kubernetes `restricted` Pod Security level.
- The app server sends a strict Content Security Policy (`default-src 'self'`), `nosniff`,
  `X-Frame-Options` and no referrer, the same in every deployment.
- On the installer the service runs as its own system user, sandboxed by systemd, and
  reaches the local database through its Unix socket without a password.
- Database passwords live in the environment file (`/opt/@@APP_ID@@/@@APP_ID@@.env`, mode 640),
  in Docker's `.env`, or in a Kubernetes Secret: never in the repository or the image.
@@END@@
@@IF lib:auth@@
- Sign-in: passwords hashed with scrypt, sessions in an `HttpOnly` cookie (`Secure` over HTTPS),
  lockout after wrong passwords, two-factor sign-in with an authenticator app. Put
  @@APP_NAME@@ behind HTTPS (the installer does by default).
@@END@@
@@IF lib:secrets@@
- Stored secrets are encrypted with AES-256-GCM; the key is kept apart from the database.
@@END@@
