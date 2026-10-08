# FleetPilot

Run every Linux host in your datacenter from one place.

FleetPilot manages the Linux hosts of a datacenter with Ansible, from the browser. You add hosts by address, as a list, a range or a CSV file, or let FleetPilot read the VMs and containers of a Proxmox VE cluster. A **take-over** logs in once with the password of your standard installation and makes FleetPilot the manager: it creates its own user, trusts FleetPilot's SSH certificate authority, gives the host a host certificate, sets new passwords and keys (kept in an encrypted vault) and turns password logins off. From then on every run logs in with a certificate that is valid for a few minutes.

What a host should look like is described with **templates**: forms for 83 settings in ten areas (users, sudo, SSH, packages, repositories, firewall, mounts, cron jobs, and 28 ready-made services such as nginx, HAProxy, PostgreSQL, MariaDB, Docker, WireGuard, BIND, Samba, Prometheus node exporter and Zabbix agent). FleetPilot turns them into plain Ansible playbooks that you can read while you build them. Templates apply to sites, groups and single hosts; the more specific one wins. **Workflows** say what runs, when and how: by hand, on a schedule, when a host is added or a template changes; in batches, with approvals, step by step in a grid you can watch live.

It is for the people who run a few dozen to a few thousand Debian and Ubuntu servers and want one place for their inventory, their addresses, their desired state and the history of every change.

<!-- blueprint:install -->
## Installation

Three ways, all with the same app:

- **Debian 12 or 13**: the installer script below (nginx, HTTPS, Let's Encrypt, PostgreSQL and backups included).
- **Docker / Docker Compose**: `docker compose up -d` in this repository, or `docker run -p 8080:8080 ghcr.io/santiagotoro2023/fleetpilot:latest`.
- **Kubernetes**: a Helm chart (`helm install fleetpilot oci://ghcr.io/santiagotoro2023/charts/fleetpilot -n fleetpilot --create-namespace`) or a single manifest, ready for a small cluster with three nodes.

Docker, Compose, Kubernetes, Helm, the database and backups are explained step by step in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

### Debian installer

On Debian 12 or 13, as root or with sudo:

```bash
curl -fsSLO https://raw.githubusercontent.com/santiagotoro2023/fleetpilot/main/fleetpilot-install.sh
sudo bash fleetpilot-install.sh
```

FleetPilot then runs at `https://<server>:8443/`, secured with a self-signed certificate that the installer generates automatically. Your browser warns once because no public authority signed it; the installer prints the certificate's SHA-256 fingerprint so you can compare it before accepting. Plain `http://` requests to the port are sent on to HTTPS. If you'd rather have a certificate that browsers trust right away, see [Let's Encrypt](#lets-encrypt) below.

| Command | Effect |
|---|---|
| `sudo bash fleetpilot-install.sh` | installs or updates (HTTPS on port 8443) |
| `sudo bash fleetpilot-install.sh --port 443` | different port. With 80, the nginx default site is disabled |
| `sudo bash fleetpilot-install.sh --http` | plain HTTP without a certificate (kept on later updates, back with `--https`) |
| `sudo bash fleetpilot-install.sh --new-cert` | generates new certificates |
| `--letsencrypt <domain> --dns <provider>` | trusted certificate from Let's Encrypt, see below |
| `--no-letsencrypt` | back to the self-signed certificate only |
| `sudo bash fleetpilot-install.sh --update` | fetches the latest version from GitHub |
| `sudo bash fleetpilot-install.sh --uninstall` | removes FleetPilot, keeps the database and the backups |
| `--uninstall --purge` | removes FleetPilot with its database and backups |
| `--backup` | backs up the database now (also automatic: daily and before every update) |
| `--restore <file>` | restores a backup (backs up the current state first) |
| `--list-backups` | lists the backups in `/var/backups/fleetpilot` |
| `--database-url postgres://…` | uses an existing PostgreSQL server instead of a local one (back with `--local-database`) |
| `--no-auto-backup` | no daily backup (back with `--auto-backup`) |
| `--force` | also installs on untested systems |
| `--no-move-card` | never show the card "FleetPilot has a new address" (e.g. behind a reverse proxy or when people use the IP on purpose), back with `--move-card` |
| `--moved-to https://new.example.com` | FleetPilot moved elsewhere (e.g. to Kubernetes): every user gets a one-click move of their browser data (`--not-moved` removes it) |

The script installs nginx, Node.js and PostgreSQL (and openssl, if missing) from the Debian packages. It writes the web app to `/opt/fleetpilot/www` and the app server to `/opt/fleetpilot/app`, creates the database `fleetpilot` with its own user, runs the app server as the systemd service `fleetpilot` (as the system user `fleetpilot`, sandboxed, listening only on 127.0.0.1) and creates `/etc/nginx/sites-available/fleetpilot`, which passes the requests to it.
The certificate and key live in `/opt/fleetpilot/tls/`. The certificate covers the hostname, `localhost` and all IP addresses of the server and is valid for 825 days. Updates keep it, so browsers don't warn again; it is only replaced when it expires within 30 days or with `--new-cert`. To use your own certificate, replace `fleetpilot.crt` and `fleetpilot.key` there and run `systemctl reload nginx`. If `ufw` is active, the port is opened. At runtime FleetPilot loads nothing from the internet, so it also works in isolated networks.

All settings (port, HTTP or HTTPS, Let's Encrypt, the address options) are saved in `/opt/fleetpilot/fleetpilot.conf`, and updates keep them. A copy of the installer is kept at `/opt/fleetpilot/fleetpilot-install.sh`.

### Let's Encrypt

If the server has a domain name, it can get a certificate from Let's Encrypt. The domain is verified with a DNS TXT record, so port 80 doesn't need to be open and the server can sit in a private network, as long as the name points to it in DNS. This works for new installs and existing ones (download the current script as shown above, then run it with the new options):

```bash
# With the API of your DNS provider (here Cloudflare), renews itself
sudo CF_Token=xxxxx CF_Zone_ID=xxxxx bash fleetpilot-install.sh --letsencrypt fleetpilot.example.com --dns dns_cf

# Without an API: the script shows the TXT record, you create it by hand and press Enter
sudo bash fleetpilot-install.sh --letsencrypt fleetpilot.example.com --dns manual
```

`--dns` takes the name of any DNS provider that [acme.sh supports](https://github.com/acmesh-official/acme.sh/wiki/dnsapi) (`dns_cf`, `dns_hetzner`, `dns_ionos`, `dns_aws`, `dns_gd`, …). The wiki page lists the environment variables each provider needs. Pass them once, after `sudo` as shown, and acme.sh keeps them for renewals. `--email you@example.com` is optional. The installer fetches acme.sh 3.1.6 from a fixed commit, checks its checksum and keeps it in `/opt/fleetpilot/acme`. A daily systemd timer (`fleetpilot-renew.timer`) renews the certificate 30 days before it expires and reloads nginx. With `--dns manual` there is no automatic renewal: within the last 30 days, run the installer again and create the new TXT record.

The self-signed certificate keeps serving access by IP address. When someone opens FleetPilot by IP, a small card offers to move their browser data to the domain. If you don't want that card (for example because the server sits behind a reverse proxy and the address in the card would be wrong), add `--no-move-card`.

### Your data is safe

All data lives in the PostgreSQL database `fleetpilot`. The installer backs it up every day and before every update (`/var/backups/fleetpilot`, the last 14 are kept); `--backup` makes one at any time and `--restore <file>` brings one back, after backing up the current state. Updates never delete data: the app server adds to the database schema, it never removes from it. `--uninstall` keeps database and backups, only `--uninstall --purge` deletes them. Backups are standard `pg_dump` files that every deployment (Compose, Kubernetes) can restore, which is also how FleetPilot moves to another server, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#backups).

Settings of each browser (theme, panel sizes) stay in the browser, per address; the move card above carries them to a new address.
<!-- /blueprint:install -->

## What's inside

**Overview.** The fleet in numbers (hosts, managed, unreachable, drifted, runs going, waiting for approval, failed) and below only what needs someone.

**Hosts.** A map of sites and groups with every host as a card: drag hosts between groups, drag groups into each other, right-click for more. A table with search, filters and actions for many hosts at once (run a workflow, move, tag, retire, remove). The Proxmox tab connects clusters with a read-only API token (the certificate can be pinned by its fingerprint) and imports VMs and containers as hosts. A host's page shows its facts, its desired state merged from all its templates (with the playbook FleetPilot runs for it), the drift found by the last check, its secrets and its runs.

**Network.** IP address management: subnets with gateway, DNS, search domains and time servers for the hosts in them, VLANs, pools for automatic addresses, and an address map of every subnet. An address counts as free only when FleetPilot knows nothing about it *and* nothing answers on it (SSH, Windows and printer ports, then ping). Check an address, find the next free one of a pool, reserve it, or scan a subnet.

**Automate.** Templates and workflows. The template editor builds a template from settings, area by area, with the playbook live beside it; every save is a version, and "Where it applies" shows which hosts are behind and pushes the newest version to them (all, the ones behind, or chosen ones). Workflows are either *take-over* (for new hosts) or *maintenance* (for managed hosts); each is a list of steps such as "Give the host an address" (from a pool, with a conflict check), "Set new passwords", "Make SSH keys for users", "Apply templates", "Check for drift", "Update packages", "Reboot", "Wait for an approval", each with what happens when it fails and for which hosts it runs. Built-in workflows: *Take over a Debian host*, *Apply desired state*, *Check drift* (every night), *Rotate passwords*, *Update packages*, *Reboot in batches*.

**Runs.** Every run with its trigger, who started and approved it, a grid of hosts × steps, the live log (with the changed lines of every file) and buttons to approve, reject, cancel or run it again on the failed hosts.

**Settings.** Your account with two-factor sign-in; for administrators the accounts, **roles** (rights per area: hosts, network, templates and workflows, runs, vault, everywhere or only for some sites and groups, with or without approvals), sign-in and password rules, FleetPilot's own settings and the audit log. The **vault** keeps logins, passwords, SSH keys and certificates, API tokens, TLS certificates and notes, encrypted with AES-256-GCM under a key kept apart from the database; every change keeps the old version, every look at a value needs a fresh confirmation and is recorded. **SSH keys** shows FleetPilot's public key and certificate authorities and signs a short-lived certificate for your own key.

### Good to know

- **The first sign-in** needs the setup code that the installer prints (or that the app server writes to its log); administrators must use two-factor sign-in.
- **What FleetPilot needs on a host:** an SSH server and a login that can become root (with `su` or `sudo`). Python is installed by the take-over if it is missing. The templates are written for Debian and Ubuntu (apt, systemd; network files for ifupdown and netplan). Debian 12 is tested end to end on every change of the tests; Debian 13 and Ubuntu are expected to work but not yet tested that way.
- **Which connections FleetPilot makes:** SSH to the hosts (port 22 or the port you give), HTTPS to Proxmox (port 8006), and the probes of the address check. On Kubernetes, allow them with `networkPolicy.extraEgress` in the Helm values, for example `[{ ports: [{ port: 22, protocol: TCP }, { port: 8006, protocol: TCP }] }]`.
- **The key of the vault** (`/var/lib/fleetpilot/fleetpilot.key` with the installer and the image, or `FLEETPILOT_SECRET_KEY`) belongs in your backups, apart from the database backups: without it the stored secrets cannot be read.
- **Everything is plain Ansible** (`ansible.builtin` modules of ansible-core only). Texts in templates may use FleetPilot's variables (`{{ fp_name }}`, `{{ fp_fqdn }}`, `{{ fp_ip }}`, …) and nothing else, so no template can run code on the FleetPilot server.

The user guide is in [docs/GUIDE.md](docs/GUIDE.md).

<!-- blueprint:logo -->
## Logo

The logo is in [`assets/logo`](assets/logo): the icon as SVG for light and dark backgrounds, and as PNG (1024 × 1024, transparent or on the page color, plus a 180 × 180 icon for phones). It is made from `project.conf` (`LOGO_PATTERN` rows, `LOGO_COLORS` blue,green) by the blueprint, in the same style as every project of the family: a dark rounded card holding a few flat parts in signal colors, no text. `node .blueprint/tools/blueprint.mjs logo` makes the PNG files again.
<!-- /blueprint:logo -->

<!-- blueprint:development -->
## Development

FleetPilot follows the [project blueprint](https://github.com/santiagotoro2023/project-blueprint) 1.1.1 (`.blueprint/`, specification in `.blueprint/spec/`): the same design, installer, deployment, tests and repository layout as every project of the family. `project.conf` holds the settings every blueprint file is made from; [DEVIATIONS.md](DEVIATIONS.md) lists where this project deliberately differs.

```bash
npm install                             # once: Playwright for the browser tests
docker compose up -d db                 # a local PostgreSQL (or set FLEETPILOT_DATABASE_URL)
FLEETPILOT_DATABASE_URL=postgres://fleetpilot:change-me@localhost:5432/fleetpilot node server/main.mjs
                                        # the app on http://localhost:8080 (src/ and server/, no build step)
node test/run.mjs                       # unit tests (test/unit/)
node test/run.mjs --browser             # browser tests (test/browser/)
bash build.sh                           # writes the blueprint files, builds fleetpilot-install.sh
bash test/installer/run.sh debian:12    # the installer on a real Debian (Docker)
node .blueprint/tools/blueprint.mjs check    # does the project still follow the blueprint?
node .blueprint/tools/blueprint.mjs update   # move to a newer blueprint (read its changelog)
```

Every push runs all of it on GitHub (`.github/workflows/release.yml`) and publishes the image and the Helm chart from `main`.

```
project.conf          name, profile, logo: the settings of the blueprint
VERSION               the version of FleetPilot (semantic versioning)
src/                  the web app: index.html, css/base.css (design system), css/app.css,
                      fonts/, js/core/ (blueprint), js/ (this app)
server/               the app server: main.mjs, core/ (blueprint), api/ (this app),
                      migrations/ (numbered SQL files, only ever added)
installer/            core/ (blueprint) and app.sh (this app's additions)
deploy/               Docker, Compose with HTTPS, Kubernetes manifest, Helm chart
test/                 unit/, browser/, installer/, lib/ and run.mjs
docs/DEPLOYMENT.md    every way to run FleetPilot
.blueprint/           the blueprint this project follows (never edited by hand)
```
<!-- /blueprint:development -->

## Planned

- Network devices: Zyxel, FortiGate and Cisco switches and firewalls, with VLANs and intent-based networking across hosts and devices.
- More hypervisors (VMware vSphere, Hyper-V) and creating VMs from templates.
- RHEL-family hosts (dnf, firewalld, SELinux) next to Debian and Ubuntu.
- Notifications of failed runs and drift by e-mail or webhook.
