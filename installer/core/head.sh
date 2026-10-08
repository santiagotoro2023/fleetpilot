#!/usr/bin/env bash
# =============================================================================
#  FleetPilot 1.0.0
#  Run every Linux host in your datacenter from one place.
#
#  Installs FleetPilot on Debian 12 (Bookworm) or 13 (Trixie):
#  nginx serves it over HTTPS with a self-signed certificate and passes the
#  requests to the app server (Node.js, systemd service fleetpilot), which keeps
#  its data in PostgreSQL. Database, service, backups and certificates are set up
#  by this script; nothing else is downloaded except the Debian packages, with
#  --letsencrypt the acme.sh client and with --update the latest script.
#
#  Usage:
#    sudo bash fleetpilot-install.sh                 Install or update (HTTPS on port 8443)
#    sudo bash fleetpilot-install.sh --port 443      On a different port
#    sudo bash fleetpilot-install.sh --http          Plain HTTP instead of HTTPS
#    sudo bash fleetpilot-install.sh --new-cert      Generate new certificates
#    sudo bash fleetpilot-install.sh --update        Fetch the latest version from GitHub
#    sudo bash fleetpilot-install.sh --uninstall     Remove
#    sudo bash fleetpilot-install.sh --uninstall --purge   Remove including database and backups
#
#  Data (PostgreSQL database fleetpilot on this server, unless --database-url is given):
#    sudo bash fleetpilot-install.sh --backup        Back up now (also daily, the last 14 are kept)
#    sudo bash fleetpilot-install.sh --restore FILE  Restore a backup (the current state is backed up first)
#    sudo bash fleetpilot-install.sh --list-backups  Show the backups in /var/backups/fleetpilot
#    sudo bash fleetpilot-install.sh --database-url postgres://user:pass@host:5432/db
#      Use an existing PostgreSQL server instead of a local one (kept on updates;
#      back to the local database with --local-database)
#    sudo bash fleetpilot-install.sh --no-auto-backup  No daily backup (back on with --auto-backup)
#
#  Let's Encrypt certificate for a domain, checked with a DNS TXT record, so the
#  server needs no open port 80 and may sit in a private network. Works for new and
#  existing installs, updates keep it and it renews itself:
#    sudo CF_Token=... bash fleetpilot-install.sh --letsencrypt app.example.com --dns dns_cf
#      --dns is the acme.sh name of your DNS provider, its credentials are passed as
#      environment variables once: https://github.com/acmesh-official/acme.sh/wiki/dnsapi
#    sudo bash fleetpilot-install.sh --letsencrypt app.example.com --dns manual
#      Without an API: you create the TXT record by hand (renewal by hand, too)
#    --email you@example.com                        Optional contact for Let's Encrypt
#    sudo bash fleetpilot-install.sh --no-letsencrypt   Back to the self-signed certificate
#
#  Moving to another server (e.g. Docker or Kubernetes, see docs/DEPLOYMENT.md):
#    sudo bash fleetpilot-install.sh --moved-to https://fleetpilot.example.com
#      This server keeps running and shows every user a card "FleetPilot has a new
#      address" with a button that carries all their data over in one click.
#    sudo bash fleetpilot-install.sh --not-moved    Remove that card again
#
#  With a Let's Encrypt domain, people who open FleetPilot by IP address (or under
#  another name) get a card offering to move their data to the domain. To never
#  show that card, e.g. behind a reverse proxy where the address would be wrong:
#    sudo bash fleetpilot-install.sh --no-move-card   (kept on updates, back with --move-card)
# =============================================================================
set -euo pipefail

# Made from blueprint 1.1.1 (https://github.com/santiagotoro2023/project-blueprint)
APP_ID="fleetpilot"
APP_NAME="FleetPilot"
APP_VERSION="1.0.0"
APP_PROFILE="server"
APP_PORT="8443"
APP_ROOT="/opt/${APP_ID}"
APP_WWW="${APP_ROOT}/www"
APP_SITE="/etc/nginx/sites-available/${APP_ID}"
APP_LINK="/etc/nginx/sites-enabled/${APP_ID}"
APP_ACTION="install"
APP_EXTRACT_DIR=""
APP_FORCE="no"
APP_PORT_SET="no"
APP_TLS="yes"
APP_TLS_SET="no"
APP_NEW_CERT="no"
APP_TLS_DIR="${APP_ROOT}/tls"
APP_CERT="${APP_TLS_DIR}/${APP_ID}.crt"
APP_KEY="${APP_TLS_DIR}/${APP_ID}.key"
APP_CONF="${APP_ROOT}/${APP_ID}.conf"
APP_SELF="${APP_ROOT}/${APP_ID}-install.sh"
APP_LE_DOMAIN=""
APP_LE_DNS=""
APP_LE_EMAIL=""
APP_LE_SET="no"
APP_MOVED_TO=""
APP_MOVED_SET="no"
APP_MOVE_CARD="yes"
APP_MOVE_CARD_SET="no"
APP_LE_CERT="${APP_TLS_DIR}/letsencrypt.crt"
APP_LE_KEY="${APP_TLS_DIR}/letsencrypt.key"
APP_ACME_HOME="${APP_ROOT}/acme"
APP_ACME_COMMIT="807da6498377ee5e0cf43a78091f46f12dc59a89"   # acme.sh 3.1.6
APP_ACME_SHA256="c7d68b021cfd6380ea83a82962abde5b484779fee0b97d38681dfa1396bbc8d7"
APP_ACME_URL="${APP_ACME_URL:-https://raw.githubusercontent.com/acmesh-official/acme.sh/${APP_ACME_COMMIT}}"
APP_ACME_SERVER="${APP_ACME_SERVER:-letsencrypt}"
APP_RENEW="${APP_ID}-renew"
APP_REPO="santiagotoro2023/fleetpilot"
APP_SCRIPT_URL="https://raw.githubusercontent.com/${APP_REPO}/main/${APP_ID}-install.sh"
APP_USER="${APP_ID}"
APP_SERVICE="${APP_ID}"
APP_BACKEND_PORT="${APP_BACKEND_PORT:-18080}"   # the app server, only on 127.0.0.1
APP_ENV_FILE="${APP_ROOT}/${APP_ID}.env"
APP_BACKUP_DIR="/var/backups/${APP_ID}"
APP_BACKUP_KEEP=14
APP_BACKUP_UNIT="${APP_ID}-backup"
APP_DB_URL=""
APP_DB_SET="no"
APP_AUTO_BACKUP="yes"
APP_AUTO_BACKUP_SET="no"
APP_PURGE="no"
APP_RESTORE_FILE=""
APP_KEY_DIR="/var/lib/${APP_ID}"
APP_KEY_FILE="${APP_KEY_DIR}/${APP_ID}.key"   # encrypts the stored secrets: back it up apart from the database

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓ \033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m ! \033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m ✗ \033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR > 2 && /^# =====/ { exit } NR > 2' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}
need() { [ -n "${2:-}" ] || die "$1 needs a value (help with --help)"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)      need "$1" "${2:-}"; APP_PORT="$2"; APP_PORT_SET="yes"; shift 2 ;;
    --port=*)    APP_PORT="${1#*=}"; APP_PORT_SET="yes"; shift ;;
    --http)      APP_TLS="no"; APP_TLS_SET="yes"; shift ;;
    --https)     APP_TLS="yes"; APP_TLS_SET="yes"; shift ;;
    --new-cert)  APP_NEW_CERT="yes"; shift ;;
    --letsencrypt)   need "$1" "${2:-}"; APP_LE_DOMAIN="$2"; APP_LE_SET="yes"; shift 2 ;;
    --letsencrypt=*) APP_LE_DOMAIN="${1#*=}"; APP_LE_SET="yes"; shift ;;
    --dns)           need "$1" "${2:-}"; APP_LE_DNS="$2"; shift 2 ;;
    --dns=*)         APP_LE_DNS="${1#*=}"; shift ;;
    --email)         need "$1" "${2:-}"; APP_LE_EMAIL="$2"; shift 2 ;;
    --email=*)       APP_LE_EMAIL="${1#*=}"; shift ;;
    --no-letsencrypt) APP_LE_DOMAIN=""; APP_LE_SET="off"; shift ;;
    --moved-to)  need "$1" "${2:-}"; APP_MOVED_TO="$2"; APP_MOVED_SET="yes"; shift 2 ;;
    --moved-to=*) APP_MOVED_TO="${1#*=}"; APP_MOVED_SET="yes"; shift ;;
    --not-moved) APP_MOVED_TO=""; APP_MOVED_SET="off"; shift ;;
    --no-move-card) APP_MOVE_CARD="no"; APP_MOVE_CARD_SET="yes"; shift ;;
    --move-card) APP_MOVE_CARD="yes"; APP_MOVE_CARD_SET="yes"; shift ;;
    --update)    APP_ACTION="update"; shift ;;
    --uninstall) APP_ACTION="uninstall"; shift ;;
    --purge)     APP_PURGE="yes"; shift ;;
    --backup)    APP_ACTION="backup"; shift ;;
    --restore)   need "$1" "${2:-}"; APP_ACTION="restore"; APP_RESTORE_FILE="$2"; shift 2 ;;
    --list-backups) APP_ACTION="list-backups"; shift ;;
    --database-url)   need "$1" "${2:-}"; APP_DB_URL="$2"; APP_DB_SET="yes"; shift 2 ;;
    --database-url=*) APP_DB_URL="${1#*=}"; APP_DB_SET="yes"; shift ;;
    --local-database) APP_DB_URL=""; APP_DB_SET="off"; shift ;;
    --no-auto-backup) APP_AUTO_BACKUP="no"; APP_AUTO_BACKUP_SET="yes"; shift ;;
    --auto-backup)    APP_AUTO_BACKUP="yes"; APP_AUTO_BACKUP_SET="yes"; shift ;;
    --force)     APP_FORCE="yes"; shift ;;
    -h|--help)   usage ;;
    *) die "Unknown option: $1 (help with --help)" ;;
  esac
done
if [ -n "$APP_MOVED_TO" ]; then
  APP_MOVED_TO="${APP_MOVED_TO%/}"
  printf '%s' "$APP_MOVED_TO" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' || die "--moved-to needs an address like https://${APP_ID}.example.com (no path)"
fi
if [ -n "$APP_DB_URL" ]; then
  printf '%s' "$APP_DB_URL" | grep -Eq '^postgres(ql)?://[^[:space:]]+$' || die "--database-url needs a PostgreSQL URL like postgres://user:password@host:5432/${APP_ID}"
fi

case "$APP_PORT" in
  ''|*[!0-9]*) die "Invalid port: ${APP_PORT}" ;;
esac
[ "$APP_PORT" -ge 1 ] && [ "$APP_PORT" -le 65535 ] || die "Port must be between 1 and 65535."

