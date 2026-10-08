# 4. The installer

Every app installs on a Debian server with one script, `<id>-install.sh`, with the same options,
the same behavior, the same files on the server and the same messages. It is built by `build.sh`
from the blueprint's installer core (`installer/core/`) and the app's additions
(`installer/app.sh`). The README of every app documents it through the managed block `install`.

## 4.1 Principles

- **One file, no dependencies.** The script carries the whole app (web files, and in the server
  profile the app server with its dependencies). At run time it downloads nothing except Debian
  packages, acme.sh for Let's Encrypt (from a fixed commit, checked by SHA-256) and, with
  `--update`, the newest script.
- **Install and update are the same command.** Running the script again updates; nothing is
  lost: settings, certificates, data.
- **Settings stick.** Every option given once is saved in `/opt/<id>/<id>.conf` and kept by later
  runs and updates; options on the command line win.
- **Nothing by surprise.** Every step prints one line (`==>` doing, `✓` done, `!` warning, `✗`
  stop). Errors say what to do. The end prints the addresses and the certificate fingerprint.
- **Debian 12 and 13.** Other systems refuse unless `--force`.
- **Secure by default.** HTTPS with a self-signed certificate from the first minute, Let's
  Encrypt on request, security headers, the firewall port opened if `ufw` runs.

## 4.2 Options

| Option | Effect | Kept? |
|---|---|---|
| *(none)* | install or update, HTTPS on the default port (`APP_PORT`) | |
| `--port <n>` | another port (80 disables nginx's default site) | yes |
| `--http` / `--https` | plain HTTP / back to HTTPS | yes |
| `--new-cert` | new certificates now | |
| `--letsencrypt <domain> --dns <provider>` | trusted certificate, DNS-01 challenge via acme.sh, renews daily by systemd timer `<id>-renew` | yes |
| `--dns manual` | TXT record by hand, no automatic renewal | yes |
| `--email <address>` | contact for Let's Encrypt | yes |
| `--no-letsencrypt` | back to the self-signed certificate | yes |
| `--moved-to <url>` | the app moved: every user gets a one-click move of their browser data | yes |
| `--not-moved` | remove that again | yes |
| `--no-move-card` / `--move-card` | never / again offer to move to the main address | yes |
| `--update` | download the newest script of exactly the newest commit on `main` and run it with the saved settings; never installs an older version | |
| `--uninstall` | remove the app (server profile: keeps database and backups) | |
| `--force` | run on untested systems | |
| `--extract <dir>` | static profile: only write the web files, no root needed | |
| `--backup` | server: back up the database now | |
| `--restore <file>` | server: restore a backup (the current state is backed up first) | |
| `--list-backups` | server: list the backups | |
| `--database-url <url>` / `--local-database` | server: an external PostgreSQL / back to the local one | yes |
| `--no-auto-backup` / `--auto-backup` | server: no daily backup / again | yes |
| `--uninstall --purge` | server: remove including database and backups | |
| `-h`, `--help` | the usage from the script's header | |

Apps never rename or remove an option. New options are added to the blueprint (12-library.md
for features, 13-updating.md for versions), never only in one app.

## 4.3 What lands on the server

| Path | What |
|---|---|
| `/opt/<id>/www/` | the web app (`src/`), owned by root, readable by all |
| `/opt/<id>/app/` | server: the app server (`server/`, `node_modules/`, `package.json`) |
| `/opt/<id>/<id>.conf` | the saved settings |
| `/opt/<id>/<id>.env` | server: the service environment (mode 640, root:<id>) |
| `/opt/<id>/<id>-install.sh` | a copy of the script for later runs |
| `/opt/<id>/VERSION` | the installed version |
| `/opt/<id>/tls/` | `<id>.crt`/`.key` (self-signed, 825 days), `letsencrypt.crt`/`.key` |
| `/opt/<id>/acme/` | acme.sh and its state, with Let's Encrypt |
| `/etc/nginx/sites-available/<id>` | the nginx site (linked in sites-enabled) |
| `/etc/systemd/system/<id>.service` | server: the app server, as system user `<id>`, sandboxed |
| `/etc/systemd/system/<id>-renew.timer` | daily certificate renewal (with Let's Encrypt) |
| `/etc/systemd/system/<id>-backup.timer` | server: daily backup |
| `/var/backups/<id>/` | server: `pg_dump` backups, the newest 14 kept |
| `/var/lib/<id>/<id>.key` | with the library element `secrets`: the key for the stored secrets (640, root:<id>); kept by `--uninstall`, removed by `--purge` |
| PostgreSQL database `<id>`, role `<id>` | server: local database, peer authentication (no password) |

## 4.4 Behavior that every app shares

- **Certificates are kept** across runs so browsers do not warn again; replaced only when they
  expire within 30 days or with `--new-cert`. The self-signed one covers host name, `localhost`
  and all IP addresses.
- **Plain HTTP on the HTTPS port** gets `migrate.html` (nginx error 497), which carries the data
  saved under the old `http://` address over to `https://` once.
- **site.json** tells the web app its version and main address (Let's Encrypt domain or
  `--moved-to`), unless `--no-move-card`.
- **Without IPv6** nginx listens on IPv4 only, and Debian's default site (which listens on
  `[::]:80`) is disabled so that nginx can start.
- **Updates** (`--update`) ask GitHub for the newest commit and load the script of exactly that
  commit (raw.githubusercontent.com caches `main` for minutes), check its syntax and that it is
  this app's installer, refuse to go back to an older version, pass on the options given with
  `--update`, and run it.
- **Server profile:** before every update the database is backed up; the service is started and
  must answer `/healthz` within 60 seconds, otherwise the script shows its log and stops; `--restore`
  backs up the current state first; `--uninstall` keeps database and backups.

- **Packages of the app** (`APP_PACKAGES`, server profile) are installed with apt together with
  the core's packages.
- **Library elements** add their parts: `secrets` makes the key once and keeps it, `auth` prints
  the setup code of the first administrator at the end of the first install.

## 4.5 The app's additions: `installer/app.sh`

Pasted between the core's settings and its actions. Usually empty. It may:

- define `app_after_install()` (runs at the end of every install and update, e.g. to print an
  extra line);
- keep lines that older versions of this app's installer need to update (PacketPilot keeps
  `PP_VERSION="@@VERSION@@"` for installers before the blueprint; `@@VERSION@@` is replaced by
  `build.sh`).

It must not change options, paths, packages or messages of the core: that is a change of the
blueprint for all apps (a deviation otherwise, 11-deviations.md).

## 4.6 Compatibility, forever

Every installed server must be able to update to the newest version with `--update` or by running
the newest script, from any older version:

- `APP_ID`, the paths of 4.3 and the keys of `<id>.conf` never change (new keys may be added).
- An option that existed keeps working.
- The installer test (`test/installer/run.sh`) installs the previous release and updates it to
  the current one in CI on Debian 12 and 13: settings, certificate and data must survive.
