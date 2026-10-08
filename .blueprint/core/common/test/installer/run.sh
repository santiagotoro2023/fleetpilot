#!/usr/bin/env bash
# Blueprint @@BLUEPRINT_VERSION@@: the installer of @@APP_NAME@@ on a real Debian with systemd (in Docker).
#   bash build.sh && bash test/installer/run.sh [debian:12|debian:13] [previous-installer.sh]
# Installs, checks HTTPS and the app, installs again (settings and certificate are kept),
# changes options,
@@IF server@@
# backs up and restores the database,
@@END@@
# and removes it again. Needs Docker that may run a privileged container.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE="${1:-debian:12}"
PREVIOUS="${2:-}"     # the installer of the previous release: tests the update from it
SCRIPT="@@APP_ID@@-install.sh"
NAME="@@APP_ID@@-installer-test-$$"
TAG="@@APP_ID@@-systemd-${IMAGE//[:\/]/-}"
[ -f "$SCRIPT" ] || { echo "Build the installer first: bash build.sh" >&2; exit 1; }

pass=0
ok()   { pass=$((pass + 1)); printf '\033[32m ✓ \033[0m %s\n' "$*"; }
fail() { printf '\033[31m ✗ \033[0m %s\n' "$*" >&2; docker exec "$NAME" sh -c 'journalctl -n 60 --no-pager 2>/dev/null; cat /etc/nginx/sites-enabled/* 2>/dev/null' >&2 || true; exit 1; }
vm()   { docker exec "$NAME" bash -c "$*"; }
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -q -t "$TAG" - >/dev/null <<DOCKERFILE
FROM ${IMAGE}
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv curl ca-certificates iproute2 procps >/dev/null && apt-get clean \
 && systemctl mask getty@tty1.service serial-getty@ttyS0.service >/dev/null 2>&1 || true
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
DOCKERFILE
docker run -d --name "$NAME" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$TAG" >/dev/null
for i in $(seq 1 60); do
  s="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  case "$s" in running|degraded) break ;; esac
  sleep 1
done
docker cp "$SCRIPT" "$NAME:/root/$SCRIPT"
echo "Testing ${SCRIPT} ($(sed -n 's/^APP_VERSION="\(.*\)"$/\1/p' "$SCRIPT")) on ${IMAGE}"

get()  { vm "curl -kfsS --max-time 10 'https://127.0.0.1:${1}${2}'"; }
fingerprint() { vm "openssl x509 -in /opt/@@APP_ID@@/tls/@@APP_ID@@.crt -noout -fingerprint -sha256"; }

# 1. Fresh install on a custom port (one that is not the default of @@APP_NAME@@)
P=8443; [ "@@APP_PORT@@" = "8443" ] && P=9443
vm "bash /root/$SCRIPT --port $P" > /tmp/$NAME.log 2>&1 || { cat /tmp/$NAME.log; fail "install"; }
ok "install"
@@IF lib:auth@@
grep -A1 "create the first administrator with this setup code" /tmp/$NAME.log | tail -1 | grep -Eq '^ +[0-9a-f]{6}-[0-9a-f]{6}-[0-9a-f]{6}$' || { cat /tmp/$NAME.log; fail "the installer shows the setup code"; }
ok "the installer shows the setup code of the first administrator"
@@END@@
get $P / | grep '<nav class="rail"' >/dev/null || fail "the app answers over HTTPS"
ok "the app answers over HTTPS on port $P"
get $P /site.json | grep '"version": *"' >/dev/null || fail "site.json"
ok "site.json"
get $P /healthz >/dev/null || fail "/healthz"
ok "/healthz"
vm "curl -sS --max-time 5 http://127.0.0.1:$P/ | grep 'moved to HTTPS\|migrate' >/dev/null" || fail "plain HTTP on the HTTPS port gets the move page"
ok "plain HTTP on the HTTPS port gets the move page"
fp="$(fingerprint)"
vm "test -x /opt/@@APP_ID@@/@@APP_ID@@-install.sh" || fail "a copy of the script for later runs"
ok "a copy of the script in /opt/@@APP_ID@@"

# 2. Running it again keeps port, certificate and options
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --no-move-card" > /tmp/$NAME.log 2>&1 || { cat /tmp/$NAME.log; fail "second run"; }
grep -q "Keeping previous port $P" /tmp/$NAME.log || fail "the port is kept"
ok "the port is kept"
[ "$(fingerprint)" = "$fp" ] || fail "the certificate is kept"
ok "the certificate is kept"
vm "grep -q '^MOVE_CARD=no' /opt/@@APP_ID@@/@@APP_ID@@.conf" || fail "--no-move-card is saved"
ok "--no-move-card is saved"

# 3. A new address shows the move card, --not-moved removes it
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --moved-to https://new.example.com" >/dev/null 2>&1 || fail "--moved-to"
get $P /site.json | grep '"canonical": *"https://new.example.com"' >/dev/null || fail "--moved-to sets the address in site.json"
ok "--moved-to sets the address in site.json"
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --not-moved" >/dev/null 2>&1 || fail "--not-moved"
get $P /site.json | grep canonical >/dev/null && fail "--not-moved removes it"
ok "--not-moved removes it"
vm "bash /root/$SCRIPT --moved-to https://bad.example.com/path" >/dev/null 2>&1 && fail "an address with a path is refused"
ok "an address with a path is refused"

# 4. Plain HTTP and back
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --http" >/dev/null 2>&1 || fail "--http"
vm "curl -fsS --max-time 5 http://127.0.0.1:$P/healthz" >/dev/null || fail "--http serves plain HTTP"
ok "--http serves plain HTTP"
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --https" >/dev/null 2>&1 || fail "--https"
get $P /healthz >/dev/null || fail "--https serves HTTPS again"
ok "--https serves HTTPS again"
@@IF server@@

# 5. The database, backups and restore
vm "systemctl is-active --quiet @@APP_ID@@" || fail "the service runs"
ok "the service @@APP_ID@@ runs"
vm "systemctl is-enabled --quiet @@APP_ID@@-backup.timer" || fail "daily backup timer"
ok "daily backup timer"
@@IF packages@@
for p in @@APP_PACKAGES@@; do vm "dpkg -s $p >/dev/null 2>&1" || fail "package $p installed"; done
ok "packages installed: @@APP_PACKAGES@@"
@@END@@
@@IF lib:secrets@@
key="$(vm "cat /var/lib/@@APP_ID@@/@@APP_ID@@.key")"
[ "$(vm "stat -c '%a %U:%G' /var/lib/@@APP_ID@@/@@APP_ID@@.key")" = "640 root:@@APP_ID@@" ] || fail "the key file belongs to root, readable by the service"
ok "key for the stored secrets in /var/lib/@@APP_ID@@ (640 root:@@APP_ID@@)"
@@END@@
vm "runuser -u postgres -- psql -d @@APP_ID@@ -Atqc 'create table if not exists installer_test (v text); insert into installer_test values (\$\$before\$\$)'" >/dev/null || fail "write to the database"
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --backup" > /tmp/$NAME.log 2>&1 || { cat /tmp/$NAME.log; fail "--backup"; }
backup="$(vm "cat /var/backups/@@APP_ID@@/.last")"
ok "--backup: $backup"
n="$(vm "ls /var/backups/@@APP_ID@@/*.dump | wc -l")"
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --backup && bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --backup" >/dev/null 2>&1 || fail "two backups in a row"
[ "$(vm "ls /var/backups/@@APP_ID@@/*.dump | wc -l")" = "$((n + 2))" ] || fail "two backups in a row are two files"
ok "two backups in a row are two files"
vm "runuser -u postgres -- psql -d @@APP_ID@@ -Atqc 'delete from installer_test'" >/dev/null
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --restore '$backup'" > /tmp/$NAME.log 2>&1 || { cat /tmp/$NAME.log; fail "--restore"; }
[ "$(vm "runuser -u postgres -- psql -d @@APP_ID@@ -Atqc 'select v from installer_test'")" = "before" ] || fail "--restore brings the data back"
ok "--restore brings the data back"
get $P /healthz >/dev/null || fail "the app runs after the restore"
ok "the app runs after the restore"
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh" > /tmp/$NAME.log 2>&1 || fail "update"
grep -q "Backing up the database before the update" /tmp/$NAME.log || fail "a backup before every update"
ok "a backup before every update"
@@IF lib:secrets@@
[ "$(vm "cat /var/lib/@@APP_ID@@/@@APP_ID@@.key")" = "$key" ] || fail "the update keeps the key"
ok "the update keeps the key"
@@END@@
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --list-backups" | grep '\.dump' >/dev/null || fail "--list-backups"
ok "--list-backups"
@@END@@

# 6. Uninstall
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --uninstall" >/dev/null 2>&1 || fail "--uninstall"
vm "test ! -e /opt/@@APP_ID@@ && test ! -e /etc/nginx/sites-enabled/@@APP_ID@@" || fail "--uninstall removes the app"
vm "curl -kfsS --max-time 5 https://127.0.0.1:$P/" >/dev/null 2>&1 && fail "nothing answers after --uninstall"
ok "--uninstall removes the app"
@@IF server@@
[ "$(vm "runuser -u postgres -- psql -d @@APP_ID@@ -Atqc 'select v from installer_test'")" = "before" ] || fail "--uninstall keeps the database"
ok "--uninstall keeps the database"
@@IF lib:secrets@@
[ "$(vm "cat /var/lib/@@APP_ID@@/@@APP_ID@@.key")" = "$key" ] || fail "--uninstall keeps the key"
ok "--uninstall keeps the key"
@@END@@
vm "bash /root/$SCRIPT" >/dev/null 2>&1 || fail "install again"
get @@APP_PORT@@ /healthz >/dev/null || fail "a new install uses the kept database"
ok "a new install uses the kept database"
vm "bash /opt/@@APP_ID@@/@@APP_ID@@-install.sh --uninstall --purge" >/dev/null 2>&1 || fail "--uninstall --purge"
vm "runuser -u postgres -- psql -Atqc \"select count(*) from pg_database where datname = '@@APP_ID@@'\"" | grep -x 0 >/dev/null || fail "--purge deletes the database"
vm "test ! -e /var/backups/@@APP_ID@@" || fail "--purge deletes the backups"
@@IF lib:secrets@@
vm "test ! -e /var/lib/@@APP_ID@@" || fail "--purge deletes the key"
@@END@@
ok "--uninstall --purge deletes database and backups"
@@END@@

# 7. Update from the previous release: settings, certificate and data are kept
if [ -n "$PREVIOUS" ] && [ -s "$PREVIOUS" ]; then
  docker cp "$PREVIOUS" "$NAME:/root/previous-install.sh"
  prev="$(sed -n 's/^APP_VERSION="\(.*\)"$/\1/p; s/^PP_VERSION="\(.*\)"$/\1/p' "$PREVIOUS" | head -1)"
  vm "bash /root/previous-install.sh --port $P --no-move-card" > /tmp/$NAME.log 2>&1 || { cat /tmp/$NAME.log; fail "install the previous release ${prev}"; }
  ok "previous release ${prev} installed"
  fp="$(fingerprint)"
@@IF server@@
  vm "runuser -u postgres -- psql -d @@APP_ID@@ -Atqc 'create table if not exists upgrade_test (v text); insert into upgrade_test values (\$\$kept\$\$)'" >/dev/null || fail "write to the database of the previous release"
@@END@@
  vm "bash /root/$SCRIPT" > /tmp/$NAME.log 2>&1 || { cat /tmp/$NAME.log; fail "update from ${prev}"; }
  ok "update from ${prev} to the new version"
  grep -q "Keeping previous port $P" /tmp/$NAME.log || fail "the update keeps the port"
  [ "$(fingerprint)" = "$fp" ] || fail "the update keeps the certificate"
  vm "grep -q '^MOVE_CARD=no' /opt/@@APP_ID@@/@@APP_ID@@.conf" || fail "the update keeps --no-move-card"
  new_version="$(sed -n 's/^APP_VERSION="\(.*\)"$/\1/p' "$SCRIPT")"
  get $P /site.json | grep "\"version\": *\"${new_version}\"" >/dev/null || fail "the new version runs after the update"
  get $P / | grep '<nav class="rail"' >/dev/null || fail "the app answers after the update"
@@IF server@@
  [ "$(vm "runuser -u postgres -- psql -d @@APP_ID@@ -Atqc 'select v from upgrade_test'")" = "kept" ] || fail "the update keeps the data"
@@END@@
  ok "the update keeps port, certificate and settings and runs the new version"
fi

echo "installer: ${pass} checks passed on ${IMAGE}"
