
check_system() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo or as root."
  [ -r /etc/os-release ] || die "/etc/os-release is missing, unknown system."
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" = "debian" ] && { [ "${VERSION_ID:-}" = "12" ] || [ "${VERSION_ID:-}" = "13" ]; }; then
    ok "Detected Debian ${VERSION_ID} (${VERSION_CODENAME:-?})"
  elif [ "$APP_FORCE" = "yes" ]; then
    warn "Untested system (${PRETTY_NAME:-unknown}), continuing anyway because of --force."
  else
    die "Tested on Debian 12 and 13, found: ${PRETTY_NAME:-unknown}. Use --force to install anyway."
  fi
}

port_in_use() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -Hltn "sport = :${APP_PORT}" 2>/dev/null | grep -q .
}

install_packages() {
  local pkgs=()
  command -v nginx >/dev/null 2>&1 || pkgs+=(nginx)
  [ "$APP_TLS" = "yes" ] && ! command -v openssl >/dev/null 2>&1 && pkgs+=(openssl)
  [ -n "$APP_LE_DOMAIN" ] && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1 && pkgs+=(curl)
@@IF server@@
  command -v node >/dev/null 2>&1 || pkgs+=(nodejs)
  command -v curl >/dev/null 2>&1 || pkgs+=(curl)
  if [ -z "$APP_DB_URL" ]; then
    command -v pg_ctlcluster >/dev/null 2>&1 || pkgs+=(postgresql)
  else
    command -v pg_dump >/dev/null 2>&1 || pkgs+=(postgresql-client)
  fi
@@END@@
@@IF packages@@
  # System packages the app server needs (APP_PACKAGES in project.conf)
  local p
  for p in @@APP_PACKAGES@@; do dpkg -s "$p" >/dev/null 2>&1 || pkgs+=("$p"); done
@@END@@
  if [ ${#pkgs[@]} -eq 0 ]; then
    ok "All packages are already installed"
  else
    say "Installing ${pkgs[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq "${pkgs[@]}" >/dev/null
    ok "${pkgs[*]} installed"
  fi
@@IF server@@
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ] || die "Node.js 18 or newer is needed, found $(node --version 2>/dev/null || echo none)."
@@END@@
}

# Self-signed certificate for this server. An existing certificate is kept so that
# browsers that already accepted it do not warn again; it is only replaced when it
# is missing, broken, expires within 30 days or --new-cert is given.
ensure_cert() {
  [ "$APP_TLS" = "yes" ] || return 0
  if [ "$APP_NEW_CERT" = "no" ] && [ -s "$APP_CERT" ] && [ -s "$APP_KEY" ] \
     && openssl x509 -in "$APP_CERT" -noout -checkend 2592000 >/dev/null 2>&1; then
    ok "Keeping the existing certificate ($(openssl x509 -in "$APP_CERT" -noout -enddate | cut -d= -f2))"
    return 0
  fi
  say "Generating a self-signed certificate"
  local host fqdn san ip
  host="$(hostname -s 2>/dev/null || hostname)"
  fqdn="$(hostname -f 2>/dev/null || true)"
  san="DNS:${host},DNS:localhost"
  [ -n "$fqdn" ] && [ "$fqdn" != "$host" ] && [ "$fqdn" != "localhost" ] && san="${san},DNS:${fqdn}"
  san="${san},IP:127.0.0.1"
  [ -f /proc/net/if_inet6 ] && san="${san},IP:::1"
  for ip in $(hostname -I 2>/dev/null || true); do
    case "$ip" in fe80:*) continue ;; esac
    san="${san},IP:${ip}"
  done
  mkdir -p "$APP_TLS_DIR"
  chmod 700 "$APP_TLS_DIR"
  # 825 days is the longest validity Apple devices accept for TLS server certificates
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
    -keyout "${APP_KEY}.new" -out "${APP_CERT}.new" \
    -subj "/CN=${host}/O=${APP_NAME}" \
    -addext "subjectAltName=${san}" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" >/dev/null 2>&1 \
    || die "Could not generate the certificate with openssl."
  chmod 600 "${APP_KEY}.new"
  chmod 644 "${APP_CERT}.new"
  mv "${APP_KEY}.new" "$APP_KEY"
  mv "${APP_CERT}.new" "$APP_CERT"
  ok "Certificate for ${san//,/, } (valid 825 days)"
}

# ------------------------------------------------------------------ Let's Encrypt
# acme.sh (a single shell script) is fetched from a fixed commit and checked, then it
# asks Let's Encrypt for a certificate and proves the domain with a DNS TXT record.
acme() { "${APP_ACME_HOME}/acme.sh" --home "$APP_ACME_HOME" --config-home "${APP_ACME_HOME}/data" --cert-home "${APP_ACME_HOME}/certs" "$@"; }

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi
}

install_acme() {
  local dir="$APP_ACME_HOME" tmp
  mkdir -p "${dir}/dnsapi" "${dir}/data" "${dir}/certs"
  chmod 700 "$dir"
  if ! echo "${APP_ACME_SHA256}  ${dir}/acme.sh" | sha256sum -c --status 2>/dev/null; then
    say "Fetching acme.sh"
    tmp="$(mktemp)"
    fetch "${APP_ACME_URL}/acme.sh" "$tmp" || die "Download failed: ${APP_ACME_URL}/acme.sh"
    echo "${APP_ACME_SHA256}  ${tmp}" | sha256sum -c --status || { rm -f "$tmp"; die "acme.sh does not match the expected checksum, aborting."; }
    install -m 700 "$tmp" "${dir}/acme.sh"
    rm -f "$tmp"
    ok "acme.sh installed in ${dir}"
  fi
  if [ "$APP_LE_DNS" != "manual" ] && [ ! -s "${dir}/dnsapi/${APP_LE_DNS}.sh" ]; then
    tmp="$(mktemp)"
    fetch "${APP_ACME_URL}/dnsapi/${APP_LE_DNS}.sh" "$tmp" 2>/dev/null \
      || { rm -f "$tmp"; die "Unknown DNS provider '${APP_LE_DNS}'. The names are listed at https://github.com/acmesh-official/acme.sh/wiki/dnsapi"; }
    install -m 600 "$tmp" "${dir}/dnsapi/${APP_LE_DNS}.sh"
    rm -f "$tmp"
  fi
}

# Is there a certificate for the domain that acme.sh can renew and that is valid for 30 more days?
le_cert_ok() {
  [ -s "$APP_LE_CERT" ] && [ -s "$APP_LE_KEY" ] || return 1
  local conf want="$APP_LE_DNS"
  conf="$(ls "${APP_ACME_HOME}/certs/${APP_LE_DOMAIN}"*/"${APP_LE_DOMAIN}.conf" 2>/dev/null | head -1)"
  [ -n "$conf" ] || return 1
  # Renewals use the DNS provider of the last issue: a new provider needs a new certificate
  [ "$want" = "manual" ] && want="dns"
  grep -q "^Le_Webroot='\{0,1\}${want}'\{0,1\}\$" "$conf" || return 1
  openssl x509 -in "$APP_LE_CERT" -noout -checkend 2592000 >/dev/null 2>&1 || return 1
  openssl x509 -in "$APP_LE_CERT" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:${APP_LE_DOMAIN}\(,\|\$\)"
}

le_check_options() {
  [ -n "$APP_LE_DOMAIN" ] || return 0
  printf '%s' "$APP_LE_DOMAIN" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$' \
    || die "Not a domain name: ${APP_LE_DOMAIN} (an IP address cannot get a Let's Encrypt certificate this way)"
  APP_LE_DOMAIN="$(printf '%s' "$APP_LE_DOMAIN" | tr 'A-Z' 'a-z')"
  [ -n "$APP_LE_DNS" ] || die "Which DNS provider? Add --dns <name> (e.g. dns_cf) or --dns manual."
  case "$APP_LE_DNS" in manual) ;; dns_*) ;; *) APP_LE_DNS="dns_${APP_LE_DNS}" ;; esac
  printf '%s' "$APP_LE_DNS" | grep -Eq '^(manual|dns_[a-z0-9_]+)$' || die "Invalid DNS provider name: ${APP_LE_DNS}"
  [ -z "$APP_LE_EMAIL" ] || printf '%s' "$APP_LE_EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || die "Invalid e-mail address: ${APP_LE_EMAIL}"
  if [ "$APP_TLS" = "no" ]; then
    if [ "$APP_TLS_SET" = "yes" ]; then
      [ "$APP_LE_SET" = "yes" ] && die "--letsencrypt needs HTTPS, it cannot be combined with --http."
      die "Let's Encrypt is set up for ${APP_LE_DOMAIN} and needs HTTPS. For plain HTTP add --no-letsencrypt."
    fi
    APP_TLS="yes"
    ok "Switching to HTTPS for the Let's Encrypt certificate"
  fi
}

ensure_le() {
  if [ -z "$APP_LE_DOMAIN" ]; then
    [ "$APP_LE_SET" = "off" ] && remove_le
    return 0
  fi
  install_acme
  # Another domain before: stop renewing it, both would write the same certificate files
  local dir old
  for dir in "${APP_ACME_HOME}"/certs/*/; do
    [ -d "$dir" ] || continue
    old="$(basename "$dir")"; old="${old%_ecc}"
    if [ "$old" != "$APP_LE_DOMAIN" ]; then
      acme --remove -d "$old" --ecc >/dev/null 2>&1 || true
      rm -rf "${APP_ACME_HOME}/certs/${old}" "${APP_ACME_HOME}/certs/${old}_ecc"
      ok "No longer renewing the certificate for ${old}"
    fi
  done
  if [ "$APP_NEW_CERT" = "no" ] && le_cert_ok; then
    ok "Keeping the Let's Encrypt certificate for ${APP_LE_DOMAIN} (until $(openssl x509 -in "$APP_LE_CERT" -noout -enddate | cut -d= -f2))"
    ensure_renewal
    return 0
  fi
  say "Requesting a Let's Encrypt certificate for ${APP_LE_DOMAIN} (DNS challenge)"
  # Extra acme.sh arguments for tests against a local test CA, e.g. "--insecure --dnssleep 1"
  # shellcheck disable=SC2206
  local extra=(${APP_ACME_ARGS:-${PP_ACME_ARGS:-}}) rc=0
  if [ -n "$APP_LE_EMAIL" ]; then
    acme --register-account --server "$APP_ACME_SERVER" -m "$APP_LE_EMAIL" "${extra[@]}" >/dev/null 2>&1 || warn "Could not register ${APP_LE_EMAIL} with Let's Encrypt, continuing without."
  fi
  local args=(--issue --server "$APP_ACME_SERVER" -d "$APP_LE_DOMAIN" --keylength ec-256)
  [ "$APP_NEW_CERT" = "yes" ] && args+=(--force)
  # acme.sh talks a lot: its messages go to a log and are shown when something fails
  local log="${APP_ACME_HOME}/last-run.log"
  if [ "$APP_LE_DNS" = "manual" ]; then
    [ -t 0 ] || die "--dns manual waits for you to create a DNS record, run it in an interactive terminal."
    acme "${args[@]}" --dns --yes-I-know-dns-manual-mode-enough-go-ahead-please "${extra[@]}" > "$log" 2>&1 || rc=$?
    if [ "$rc" -eq 3 ]; then
      echo
      say "Create this TXT record at your DNS provider:"
      sed -n "s/.*Domain: *'\([^']*\)'.*/      Name:  \1/p; s/.*TXT value: *'\([^']*\)'.*/      Value: \1/p" "$log"
      echo "    Check that it is visible, e.g.: dig +short TXT _acme-challenge.${APP_LE_DOMAIN}"
      read -r -p "    Press Enter when the record is published ... " _
      rc=0
      acme --renew -d "$APP_LE_DOMAIN" --ecc --yes-I-know-dns-manual-mode-enough-go-ahead-please "${extra[@]}" > "$log" 2>&1 || rc=$?
    fi
  else
    acme "${args[@]}" --dns "$APP_LE_DNS" "${extra[@]}" > "$log" 2>&1 || rc=$?
  fi
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
    sed 's/^/    /' "$log" | grep -v -e '-----' -e '^    [A-Za-z0-9+/=]\{40,\}$' | tail -n 20 >&2
    if grep -qi "credentials\|api key\|token\|You don't specify" "$log"; then
      warn "The DNS provider needs its credentials as environment variables, see"
      warn "https://github.com/acmesh-official/acme.sh/wiki/dnsapi (sudo keeps them only when given after sudo)."
    fi
  fi
  # 2: nothing to do, the certificate is still fresh
  [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ] || die "Let's Encrypt did not issue a certificate (full log: ${log}). Nothing was changed, ${APP_NAME} keeps its current certificate."
  mkdir -p "$APP_TLS_DIR"
  acme --install-cert -d "$APP_LE_DOMAIN" --ecc --key-file "$APP_LE_KEY" --fullchain-file "$APP_LE_CERT" \
    --reloadcmd "systemctl reload nginx" >/dev/null 2>&1 || true
  [ -s "$APP_LE_CERT" ] && [ -s "$APP_LE_KEY" ] || die "acme.sh did not store the certificate in ${APP_TLS_DIR}."
  chmod 600 "$APP_LE_KEY"
  ok "Let's Encrypt certificate for ${APP_LE_DOMAIN} (until $(openssl x509 -in "$APP_LE_CERT" -noout -enddate | cut -d= -f2))"
  ensure_renewal
}

# A daily systemd timer (or cron job without systemd) that runs a command as root
daily_job() {
  local unit="$1" what="$2" cmd="$3"
  if [ -d /run/systemd/system ]; then
    cat > "/etc/systemd/system/${unit}.service" <<UNIT
[Unit]
Description=${what}
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=${cmd}
UNIT
    cat > "/etc/systemd/system/${unit}.timer" <<UNIT
[Unit]
Description=${what} (daily)

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload
    systemctl enable --now "${unit}.timer" >/dev/null 2>&1 || warn "Could not enable ${unit}.timer"
    ok "${what}: systemd timer ${unit}.timer"
  else
    printf '# %s: %s\n%s %s * * * root %s >/dev/null 2>&1\n' "$APP_NAME" "$what" \
      "$((RANDOM % 60))" "$((RANDOM % 24))" "$cmd" > "/etc/cron.d/${unit}"
    ok "${what}: /etc/cron.d/${unit}"
  fi
}

remove_daily_job() {
  local unit="$1"
  if [ -f "/etc/systemd/system/${unit}.timer" ]; then
    systemctl disable --now "${unit}.timer" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${unit}.timer" "/etc/systemd/system/${unit}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "/etc/cron.d/${unit}"
}

# A daily check renews the certificate 30 days before it expires and reloads nginx
ensure_renewal() {
  if [ "$APP_LE_DNS" = "manual" ]; then
    remove_renewal
    warn "Manual DNS: the certificate does not renew itself. Within 30 days before"
    warn "$(openssl x509 -in "$APP_LE_CERT" -noout -enddate | cut -d= -f2) run again: sudo bash ${APP_SELF}"
    return 0
  fi
  daily_job "$APP_RENEW" "Renew the Let's Encrypt certificate of ${APP_NAME}" \
    "${APP_ACME_HOME}/acme.sh --cron --home ${APP_ACME_HOME} --config-home ${APP_ACME_HOME}/data --cert-home ${APP_ACME_HOME}/certs"
}

remove_renewal() { remove_daily_job "$APP_RENEW"; }

remove_le() {
  remove_renewal
  [ -d "$APP_ACME_HOME" ] || [ -f "$APP_LE_CERT" ] || return 0
  rm -rf "$APP_ACME_HOME"
  rm -f "$APP_LE_CERT" "$APP_LE_KEY"
  ok "Let's Encrypt removed, back to the self-signed certificate"
}

# One server block per certificate: the self-signed one answers for IP addresses and
# other names, the Let's Encrypt one for its domain. Both serve the same app.
server_block() {
  local name="$1" cert="$2" key="$3" listen4="$4" listen6="$5" tls=""
  if [ -n "$cert" ]; then
    tls="
    ssl_certificate     ${cert};
    ssl_certificate_key ${key};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:${APP_ID}:1m;
    ssl_session_timeout 1d;
    # Plain HTTP on the HTTPS port: a small page that moves to HTTPS and takes the
    # data saved under the old http:// address along (it lives in the browser)
    error_page 497 =200 /migrate.html;
"
  fi
@@IF static@@
  cat <<NGINX
server {
${listen4}
${listen6}
    server_name ${name};
${tls}
    root ${APP_WWW};
    index index.html;
    charset utf-8;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'" always;

    location = /healthz {
        access_log off;
        default_type text/plain;
        return 200 "ok\n";
    }
    location / {
        try_files \$uri \$uri/ /index.html;
    }
    location ~* \.(js|css|json|html)\$ {
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'" always;
    }
}
NGINX
@@END@@
@@IF server@@
  # The app server sends the security headers itself (the same in every deployment)
  cat <<NGINX
server {
${listen4}
${listen6}
    server_name ${name};
${tls}
    charset utf-8;
    client_max_body_size 16m;
    server_tokens off;

    location / {
        proxy_pass http://127.0.0.1:${APP_BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 120s;
    }
}
NGINX
@@END@@
}

write_site() {
  say "Writing nginx configuration for port ${APP_PORT}"
  local listen6="    listen [::]:${APP_PORT};" listen4="    listen ${APP_PORT};" note=" (--http)"
  if [ ! -f /proc/net/if_inet6 ]; then
    listen6="    # IPv6 is not available on this system"
    warn "No IPv6 available, ${APP_NAME} only listens on IPv4."
  fi
  if [ "$APP_TLS" = "yes" ]; then
    note=""
    listen4="${listen4/;/ ssl;}"
    listen6="${listen6/:${APP_PORT};/:${APP_PORT} ssl;}"
  fi
  {
    echo "# ${APP_NAME} ${APP_VERSION}, generated by ${APP_ID}-install.sh${note}"
    echo "# Settings: ${APP_CONF}"
@@IF server@@
    echo "map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }"
@@END@@
    if [ "$APP_TLS" = "yes" ]; then
      server_block "_" "$APP_CERT" "$APP_KEY" "$listen4" "$listen6"
      if [ -n "$APP_LE_DOMAIN" ]; then
        echo
        server_block "$APP_LE_DOMAIN" "$APP_LE_CERT" "$APP_LE_KEY" "$listen4" "$listen6"
      fi
    else
      server_block "_" "" "" "$listen4" "$listen6"
    fi
  } > "$APP_SITE"
  ln -sf "$APP_SITE" "$APP_LINK"
  if [ "$APP_PORT" = "80" ] && [ -L /etc/nginx/sites-enabled/default ]; then
    warn "Port 80: the nginx default site is disabled (only the link in sites-enabled, the file stays)."
    rm -f /etc/nginx/sites-enabled/default
  fi
  # Without IPv6 the Debian default site (listen [::]:80) stops nginx from starting at all
  if [ ! -f /proc/net/if_inet6 ] && [ -L /etc/nginx/sites-enabled/default ] && grep -q 'listen \[::\]' /etc/nginx/sites-enabled/default; then
    warn "No IPv6: the nginx default site, which listens on [::]:80, is disabled (only the link in sites-enabled, the file stays)."
    rm -f /etc/nginx/sites-enabled/default
  fi
  nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx configuration is invalid, see above."; }
  systemctl enable --now nginx >/dev/null 2>&1 || true
  local old_workers; old_workers="$(nginx_workers)"
  systemctl reload nginx
  # The reload only signals nginx: wait until the old workers are gone, so the new
  # settings (HTTP or HTTPS, port, certificate) are what answers when this script ends
  local i w left
  for i in $(seq 1 50); do
    left=""
    for w in $old_workers; do [ -d "/proc/$w" ] && left=1; done
    [ -z "$left" ] && break
    sleep 0.2
  done
  ok "nginx reloaded"
}

# The worker processes of the running nginx (nothing when it does not run)
nginx_workers() {
  local master; master="$(cat /run/nginx.pid 2>/dev/null || true)"
  [ -n "$master" ] && [ -d "/proc/$master" ] || return 0
  if command -v pgrep >/dev/null 2>&1; then pgrep -P "$master" || true
  else cat "/proc/$master/task/$master/children" 2>/dev/null || true; fi
}

# The address users should use. The web app offers to move their data there when it
# is opened under another address (browser data is stored per address).
main_url() {
  local scheme="http" port=""
  [ "$APP_TLS" = "yes" ] && scheme="https"
  { [ "$scheme" = "https" ] && [ "$APP_PORT" = "443" ]; } || { [ "$scheme" = "http" ] && [ "$APP_PORT" = "80" ]; } || port=":${APP_PORT}"
  [ -n "$APP_LE_DOMAIN" ] && echo "${scheme}://${APP_LE_DOMAIN}${port}/"
  return 0
}

# The public address the web app is told about (site.json), empty for none
canonical_url() {
  local url
  url="$(main_url)"
  # --no-move-card: no main address, so no browser is ever told to move (share links
  # then use whatever address the user opened)
  [ "$APP_MOVE_CARD" = "no" ] && url=""
  # A new home elsewhere (--moved-to) is an explicit wish: it always shows the card
  [ -n "$APP_MOVED_TO" ] && url="$APP_MOVED_TO"
  printf '%s' "${url%/}"
}

write_site_json() {
@@IF static@@
  local url
  url="$(canonical_url)"
  if [ -n "$url" ]; then
    printf '{ "version": "%s", "canonical": "%s" }\n' "$APP_VERSION" "$url" > "${APP_WWW}/site.json"
  else
    printf '{ "version": "%s" }\n' "$APP_VERSION" > "${APP_WWW}/site.json"
  fi
@@END@@
@@IF server@@
  # The app server answers /site.json from its environment (see write_env)
  return 0
@@END@@
}

open_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${APP_PORT}/tcp" >/dev/null && ok "ufw: port ${APP_PORT}/tcp opened"
  fi
}

# Settings of the last install, so updates and reinstalls change nothing by surprise.
# Options on the command line win.
save_settings() {
  mkdir -p "$APP_ROOT"
  cat > "$APP_CONF" <<CONF
# ${APP_NAME} settings, written by ${APP_ID}-install.sh and kept across updates.
# Change them with the options of the script (see --help), not here.
PORT=${APP_PORT}
TLS=${APP_TLS}
LE_DOMAIN=${APP_LE_DOMAIN}
LE_DNS=${APP_LE_DNS}
LE_EMAIL=${APP_LE_EMAIL}
MOVED_TO=${APP_MOVED_TO}
MOVE_CARD=${APP_MOVE_CARD}
@@IF server@@
DATABASE=$([ -n "$APP_DB_URL" ] && echo external || echo local)
AUTO_BACKUP=${APP_AUTO_BACKUP}
@@END@@
CONF
  chmod 644 "$APP_CONF"
}

keep_settings() {
  local k v c_port="" c_tls="" c_domain="" c_dns="" c_email="" c_moved="" c_card=""
@@IF server@@
  local c_backup=""
@@END@@
  if [ -f "$APP_CONF" ]; then
    while IFS='=' read -r k v; do
      case "$k" in
        PORT) c_port="$v" ;; TLS) c_tls="$v" ;; LE_DOMAIN) c_domain="$v" ;; LE_DNS) c_dns="$v" ;; LE_EMAIL) c_email="$v" ;; MOVED_TO) c_moved="$v" ;; MOVE_CARD) c_card="$v" ;;
@@IF server@@
        AUTO_BACKUP) c_backup="$v" ;;
@@END@@
      esac
    done < "$APP_CONF"
  elif [ -f "$APP_SITE" ]; then
    # Installed by a very old version without a settings file: read the nginx site
    c_port="$(awk '/^[[:space:]]*listen[[:space:]]+[0-9]+[[:space:];]/ { gsub(";", "", $2); print $2; exit }' "$APP_SITE")"
    c_tls="yes"
    grep -q "^# ${APP_NAME}.*--http" "$APP_SITE" && c_tls="no"
  fi
  if [ "$APP_PORT_SET" = "no" ] && [ -n "$c_port" ] && [ "$c_port" != "$APP_PORT" ]; then
    case "$c_port" in *[!0-9]*) ;; *) APP_PORT="$c_port"; ok "Keeping previous port ${APP_PORT} (change with --port)" ;; esac
  fi
  if [ "$APP_TLS_SET" = "no" ] && [ "$c_tls" = "no" ]; then
    APP_TLS="no"
    ok "Keeping plain HTTP (switch with --https)"
  fi
  if [ "$APP_MOVE_CARD_SET" = "no" ] && [ "$c_card" = "no" ]; then APP_MOVE_CARD="no"; ok "Keeping: no card about another address (show it again with --move-card)"; fi
  if [ "$APP_MOVED_SET" = "no" ] && [ -n "$c_moved" ]; then APP_MOVED_TO="$c_moved"; ok "Keeping the new address ${APP_MOVED_TO} (remove with --not-moved)"; fi
  case "$APP_LE_SET" in
    no)
      if [ -n "$c_domain" ]; then
        APP_LE_DOMAIN="$c_domain"; APP_LE_DNS="$c_dns"; APP_LE_EMAIL="$c_email"
        ok "Keeping Let's Encrypt for ${APP_LE_DOMAIN} (remove with --no-letsencrypt)"
      fi ;;
    yes)
      # Same domain again: the DNS provider and e-mail may be left out
      if [ "$APP_LE_DOMAIN" = "$c_domain" ]; then
        [ -n "$APP_LE_DNS" ] || APP_LE_DNS="$c_dns"
        [ -n "$APP_LE_EMAIL" ] || APP_LE_EMAIL="$c_email"
      fi ;;
  esac
@@IF server@@
  if [ "$APP_AUTO_BACKUP_SET" = "no" ] && [ "$c_backup" = "no" ]; then APP_AUTO_BACKUP="no"; ok "Keeping: no daily backup (switch on with --auto-backup)"; fi
  # The database address lives in the environment file (it may contain a password)
  if [ "$APP_DB_SET" = "no" ] && [ -f "$APP_ENV_FILE" ]; then
    local url
    url="$(sed -n 's/^@@APP_ENV@@_DATABASE_URL=//p' "$APP_ENV_FILE" | head -1)"
    case "$url" in *"host=/var/run/postgresql"*|"") ;; *) APP_DB_URL="$url"; ok "Keeping the external database (back to a local one with --local-database)" ;; esac
  fi
@@END@@
  return 0
}

@@IF server@@
# ------------------------------------------------------------------ App server and database
local_db() { [ -z "$APP_DB_URL" ]; }
# The database address the app uses: local through the Unix socket, the database user
# is the system user of the service (peer authentication, no password anywhere)
db_url() { if local_db; then printf 'postgresql:///%s?host=/var/run/postgresql' "$APP_ID"; else printf '%s' "$APP_DB_URL"; fi; }
as_postgres() { runuser -u postgres -- "$@"; }

ensure_user() {
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$APP_USER"
    ok "System user ${APP_USER}"
  fi
}

ensure_database() {
  if ! local_db; then ok "Using the external database (--database-url)"; return 0; fi
  systemctl enable --now postgresql >/dev/null 2>&1 || true
  local i
  for i in $(seq 1 30); do as_postgres psql -Atqc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
  as_postgres psql -Atqc 'select 1' >/dev/null 2>&1 || die "PostgreSQL does not answer (systemctl status postgresql)."
  if ! as_postgres psql -Atqc "select 1 from pg_roles where rolname = '${APP_USER}'" | grep -q 1; then
    as_postgres psql -qc "create role \"${APP_USER}\" login" >/dev/null
    ok "Database user ${APP_USER}"
  fi
  if ! as_postgres psql -Atqc "select 1 from pg_database where datname = '${APP_ID}'" | grep -q 1; then
    as_postgres psql -qc "create database \"${APP_ID}\" owner \"${APP_USER}\" encoding 'UTF8' template template0" >/dev/null
    ok "Database ${APP_ID}"
  else
    ok "Keeping database ${APP_ID} ($(as_postgres psql -Atqc "select pg_size_pretty(pg_database_size('${APP_ID}'))"))"
  fi
}

@@IF lib:secrets@@
# The key that encrypts the stored secrets: made once, kept by updates and --uninstall
ensure_secret_key() {
  mkdir -p "$APP_KEY_DIR"
  chown "root:${APP_USER}" "$APP_KEY_DIR"
  chmod 750 "$APP_KEY_DIR"
  if [ ! -s "$APP_KEY_FILE" ]; then
    umask 077
    head -c 32 /dev/urandom | base64 > "${APP_KEY_FILE}.new"
    umask 022
    mv "${APP_KEY_FILE}.new" "$APP_KEY_FILE"
    ok "New key for the stored secrets: ${APP_KEY_FILE}"
  else
    ok "Keeping the key for the stored secrets (${APP_KEY_FILE})"
  fi
  chown "root:${APP_USER}" "$APP_KEY_FILE"
  chmod 640 "$APP_KEY_FILE"
}

@@END@@
write_env() {
  local url
  url="$(canonical_url)"
  umask 077
  cat > "${APP_ENV_FILE}.new" <<ENV
# ${APP_NAME}: environment of the service, written by ${APP_ID}-install.sh.
@@APP_ENV@@_DATABASE_URL=$(db_url)
@@APP_ENV@@_HOST=127.0.0.1
@@APP_ENV@@_PORT=${APP_BACKEND_PORT}
@@APP_ENV@@_WEB_DIR=${APP_WWW}
@@APP_ENV@@_VERSION=${APP_VERSION}
@@APP_ENV@@_CANONICAL=${url}
@@IF lib:secrets@@
@@APP_ENV@@_SECRET_KEY_FILE=${APP_KEY_FILE}
@@END@@
NODE_ENV=production
ENV
  umask 022
  chown "root:${APP_USER}" "${APP_ENV_FILE}.new"
  chmod 640 "${APP_ENV_FILE}.new"
  mv "${APP_ENV_FILE}.new" "$APP_ENV_FILE"
}

write_service() {
  cat > "/etc/systemd/system/${APP_SERVICE}.service" <<UNIT
[Unit]
Description=${APP_NAME}
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
EnvironmentFile=${APP_ENV_FILE}
WorkingDirectory=${APP_ROOT}/app
ExecStart=$(command -v node) ${APP_ROOT}/app/server/main.mjs
Restart=on-failure
RestartSec=3
# Locked down: the service reads its files and talks to the database, nothing else
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable "${APP_SERVICE}.service" >/dev/null 2>&1
}

# Start (or restart) the service and wait until it answers /healthz
start_service() {
  say "Starting the ${APP_NAME} service"
  systemctl restart "${APP_SERVICE}.service"
  local i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${APP_BACKEND_PORT}/healthz" >/dev/null 2>&1; then ok "Service ${APP_SERVICE} is running"; return 0; fi
    sleep 1
  done
  journalctl -u "${APP_SERVICE}" -n 30 --no-pager >&2 2>/dev/null || true
  die "The service does not answer on 127.0.0.1:${APP_BACKEND_PORT}/healthz (see the log above, or: journalctl -u ${APP_SERVICE})."
}

backup_now() {
  local quiet="${1:-}" file stamp
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump is missing (apt install postgresql-client)."
  mkdir -p "$APP_BACKUP_DIR"
  chmod 700 "$APP_BACKUP_DIR"
  stamp="$(date +%Y-%m-%d-%H%M%S)"
  local ver n=1; ver="$(cat "${APP_ROOT}/VERSION" 2>/dev/null || echo "$APP_VERSION")"
  file="${APP_BACKUP_DIR}/${APP_ID}-${stamp}-${ver}.dump"
  # Never overwrite a backup (two in the same second: --backup, then --restore of it)
  while [ -e "$file" ]; do n=$((n + 1)); file="${APP_BACKUP_DIR}/${APP_ID}-${stamp}-${n}-${ver}.dump"; done
  if local_db; then
    as_postgres pg_dump -Fc "$APP_ID" > "${file}.part" || { rm -f "${file}.part"; die "Backup failed (pg_dump)."; }
  else
    pg_dump -Fc "$APP_DB_URL" > "${file}.part" || { rm -f "${file}.part"; die "Backup failed (pg_dump)."; }
  fi
  chmod 600 "${file}.part"
  mv "${file}.part" "$file"
  # Keep the newest backups only
  ls -1t "${APP_BACKUP_DIR}/${APP_ID}-"*.dump 2>/dev/null | tail -n +"$((APP_BACKUP_KEEP + 1))" | xargs -r rm -f
  [ -n "$quiet" ] || ok "Backup: ${file} ($(du -h "$file" | cut -f1))"
  printf '%s' "$file" > "${APP_BACKUP_DIR}/.last"
}

ensure_backup_job() {
  if [ "$APP_AUTO_BACKUP" = "yes" ]; then
    daily_job "$APP_BACKUP_UNIT" "Back up the ${APP_NAME} database" "/bin/bash ${APP_SELF} --backup"
  else
    remove_daily_job "$APP_BACKUP_UNIT"
    ok "No daily backup (--no-auto-backup)"
  fi
}
@@END@@

do_install() {
  check_system
  keep_settings
  le_check_options
  if port_in_use && [ ! -f "$APP_SITE" ]; then
    warn "Port ${APP_PORT} is already in use. If you run into problems, choose another one with --port."
  fi
  install_packages
  ensure_cert
  ensure_le
@@IF server@@
  ensure_user
@@IF lib:secrets@@
  ensure_secret_key
@@END@@
  ensure_database
  # An update: back up first, the new version may change the database when it starts
  if [ -f "${APP_ROOT}/VERSION" ] && { ! local_db || as_postgres psql -Atqc "select 1 from pg_database where datname = '${APP_ID}'" | grep -q 1; }; then
    say "Backing up the database before the update"
    backup_now
  fi
@@END@@
  say "Writing web files to ${APP_WWW}"
  local tmp
  tmp="$(mktemp -d)"
  write_files "$tmp"
  mkdir -p "$APP_ROOT"
  rm -rf "${APP_WWW}.new"
  mv "$tmp" "${APP_WWW}.new"
  rm -rf "$APP_WWW"
  mv "${APP_WWW}.new" "$APP_WWW"
@@IF server@@
  say "Writing the app server to ${APP_ROOT}/app"
  tmp="$(mktemp -d)"
  write_app_files "$tmp"
  rm -rf "${APP_ROOT}/app.new"
  mv "$tmp" "${APP_ROOT}/app.new"
  rm -rf "${APP_ROOT}/app"
  mv "${APP_ROOT}/app.new" "${APP_ROOT}/app"
@@END@@
  echo "$APP_VERSION" > "${APP_ROOT}/VERSION"
  write_site_json
  # A copy of this script for later runs (renewal by hand, changing options, backups)
  if [ -f "$0" ] && [ "$(readlink -f "$0")" != "$APP_SELF" ]; then install -m 755 "$0" "$APP_SELF"; fi
  chown -R root:root "$APP_ROOT"
  find "$APP_WWW" -type d -exec chmod 755 {} +
  find "$APP_WWW" -type f -exec chmod 644 {} +
  ok "$(find "$APP_WWW" -type f | wc -l) files installed"
@@IF server@@
  find "${APP_ROOT}/app" -type d -exec chmod 755 {} +
  find "${APP_ROOT}/app" -type f -exec chmod 644 {} +
  write_env
  write_service
@@IF lib:auth@@
  local started_at setup_code=""
  started_at="$(date +%s)"
@@END@@
  start_service
  ensure_backup_job
@@IF lib:auth@@
  # No account yet: the app logs the setup code of the first administrator at every start
  sleep 1
  setup_code="$(journalctl -u "${APP_SERVICE}" --since "@${started_at}" -o cat --no-pager 2>/dev/null | sed -n 's/.*"setup_code":"\([^"]*\)".*/\1/p' | tail -1)"
@@END@@
@@END@@
  write_site
  save_settings
  open_firewall
  type app_after_install >/dev/null 2>&1 && app_after_install
  local ips main
  ips="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -3 || true)"
  main="$(main_url)"
  echo
  local scheme="http"
  [ "$APP_TLS" = "yes" ] && scheme="https"
  say "${APP_NAME} ${APP_VERSION} is ready:"
  if [ -n "$main" ]; then
    echo "      ${main}"
    echo "    Also reachable by IP address (self-signed certificate there):"
  fi
  if [ -n "$ips" ]; then
    for ip in $ips; do echo "      ${scheme}://${ip}:${APP_PORT}/"; done
  else
    echo "      ${scheme}://<IP-of-this-server>:${APP_PORT}/"
  fi
  echo
  if [ "$APP_TLS" = "yes" ]; then
    if [ -n "$main" ]; then
      echo "    ${APP_LE_DOMAIN} has a certificate from Let's Encrypt, browsers trust it without a"
      echo "    warning. The domain must point to this server in DNS. Opened by IP address, the"
      echo "    app offers to move the data saved there to ${APP_LE_DOMAIN}."
    else
      echo "    The certificate is self-signed, so the browser warns once. Compare the fingerprint"
      echo "    before you accept it:"
      echo "      $(openssl x509 -in "$APP_CERT" -noout -fingerprint -sha256 | cut -d= -f2)"
      echo "    Certificate: ${APP_CERT}"
      echo "    A trusted certificate for a domain: --letsencrypt <domain> --dns <provider> (see --help)"
    fi
    echo
  fi
@@IF lib:auth@@
  if [ -n "$setup_code" ]; then
    echo "    Open the address above and create the first administrator with this setup code:"
    echo "      ${setup_code}"
    echo
  fi
@@END@@
  echo "    @@APP_DATA_NOTE@@"
@@IF static@@
  [ "$APP_TLS" = "yes" ] && echo "    Opened with http://, the old address hands its data over to https:// once."
  echo "    Update: sudo bash ${APP_SELF} --update. Remove: --uninstall"
@@END@@
@@IF server@@
  echo "    Backups: ${APP_BACKUP_DIR} ($([ "$APP_AUTO_BACKUP" = "yes" ] && echo "daily, the last ${APP_BACKUP_KEEP} are kept" || echo "only with --backup")), also before every update."
  echo "    Update: sudo bash ${APP_SELF} --update. Back up now: --backup. Remove: --uninstall"
@@END@@
@@IF lib:secrets@@
  echo "    Stored secrets are encrypted with the key in ${APP_KEY_FILE}. Back it up apart from"
  echo "    the database backups: without it, the secrets in a backup cannot be read."
@@END@@
}

do_update() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo or as root."
  local tmp new
  tmp="$(mktemp)"
  say "Downloading the latest version from github.com/${APP_REPO}"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || die "Neither curl nor wget found. Install with: apt install curl"
  fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -H "$2" "$1" -o "$3"; else wget -q --header="$2" -O "$3" "$1"; fi; }
  # raw.githubusercontent.com caches main/ for minutes: ask for the newest commit and load
  # the script of exactly that commit, which is never stale
  local sha url="$APP_SCRIPT_URL"
  if fetch "https://api.github.com/repos/${APP_REPO}/commits/main" "Accept: application/vnd.github.sha" "$tmp" 2>/dev/null; then
    sha="$(head -c 40 "$tmp")"
    case "$sha" in *[!0-9a-f]*|"") ;; *) url="https://raw.githubusercontent.com/${APP_REPO}/${sha}/${APP_ID}-install.sh" ;; esac
  fi
  fetch "$url" "Cache-Control: no-cache" "$tmp" || die "Download failed: ${url}"
  bash -n "$tmp" || die "The downloaded script is broken, aborting."
  grep -q "^APP_ID=\"${APP_ID}\"\$" "$tmp" || die "The downloaded script is not the installer of ${APP_NAME}, aborting."
  new="$(sed -n 's/^APP_VERSION="\(.*\)"$/\1/p' "$tmp" | head -1)"
  [ -n "$new" ] || die "The downloaded script has no version, aborting."
  say "Installed: $(cat "${APP_ROOT}/VERSION" 2>/dev/null || echo none), available: ${new}"
  # Never go back to an older version than the one running right now
  if [ "$new" != "$APP_VERSION" ] && [ "$(printf '%s\n%s\n' "$new" "$APP_VERSION" | sort -V | tail -1)" = "$APP_VERSION" ]; then
    warn "GitHub offers ${new}, this script is ${APP_VERSION}: installing ${APP_VERSION} instead"
    cp "$0" "$tmp" 2>/dev/null || die "Cannot reuse this script, download it again"
  fi
  local args=()
  [ "$APP_PORT_SET" = "yes" ] && args+=(--port "$APP_PORT")
  [ "$APP_FORCE" = "yes" ] && args+=(--force)
  [ "$APP_TLS_SET" = "yes" ] && { [ "$APP_TLS" = "yes" ] && args+=(--https) || args+=(--http); }
  [ "$APP_NEW_CERT" = "yes" ] && args+=(--new-cert)
  [ "$APP_LE_SET" = "yes" ] && args+=(--letsencrypt "$APP_LE_DOMAIN")
  [ "$APP_LE_SET" = "off" ] && args+=(--no-letsencrypt)
  [ -n "$APP_LE_DNS" ] && args+=(--dns "$APP_LE_DNS")
  [ -n "$APP_LE_EMAIL" ] && args+=(--email "$APP_LE_EMAIL")
  # Every option given together with --update goes to the new script as well
  [ "$APP_MOVE_CARD_SET" = "yes" ] && { [ "$APP_MOVE_CARD" = "no" ] && args+=(--no-move-card) || args+=(--move-card); }
  [ "$APP_MOVED_SET" = "yes" ] && args+=(--moved-to "$APP_MOVED_TO")
  [ "$APP_MOVED_SET" = "off" ] && args+=(--not-moved)
@@IF server@@
  [ "$APP_DB_SET" = "yes" ] && args+=(--database-url "$APP_DB_URL")
  [ "$APP_DB_SET" = "off" ] && args+=(--local-database)
  [ "$APP_AUTO_BACKUP_SET" = "yes" ] && { [ "$APP_AUTO_BACKUP" = "no" ] && args+=(--no-auto-backup) || args+=(--auto-backup); }
@@END@@
  exec bash "$tmp" "${args[@]}"
}

do_uninstall() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo or as root."
  say "Removing ${APP_NAME}"
  remove_renewal
  rm -f "$APP_LINK" "$APP_SITE"
@@IF server@@
  keep_settings >/dev/null
  remove_daily_job "$APP_BACKUP_UNIT"
  systemctl disable --now "${APP_SERVICE}.service" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${APP_SERVICE}.service"
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [ "$APP_PURGE" = "yes" ]; then
    if local_db && command -v psql >/dev/null 2>&1; then
      as_postgres psql -qc "drop database if exists \"${APP_ID}\"" >/dev/null 2>&1 || true
      as_postgres psql -qc "drop role if exists \"${APP_USER}\"" >/dev/null 2>&1 || true
      ok "Database ${APP_ID} deleted"
    fi
    rm -rf "$APP_BACKUP_DIR"
@@IF lib:secrets@@
    rm -rf "$APP_KEY_DIR"
@@END@@
    userdel "$APP_USER" >/dev/null 2>&1 || true
  fi
@@END@@
  rm -rf "$APP_ROOT"
  if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then systemctl reload nginx || true; fi
@@IF static@@
  ok "${APP_NAME} removed. nginx itself stays installed (remove with: apt purge nginx)."
@@END@@
@@IF server@@
  if [ "$APP_PURGE" = "yes" ]; then
    ok "${APP_NAME} removed with its data. nginx, Node.js and PostgreSQL stay installed."
  else
    ok "${APP_NAME} removed. Kept: the database ${APP_ID} and the backups in ${APP_BACKUP_DIR}"
@@IF lib:secrets@@
    echo "    Kept as well: the key for the stored secrets in ${APP_KEY_FILE}"
@@END@@
    echo "    (a new install uses them again; delete everything with --uninstall --purge)."
  fi
@@END@@
}

@@IF static@@
do_extract() {
  [ -n "$APP_EXTRACT_DIR" ] || die "Specify a target folder: --extract ./web"
  mkdir -p "$APP_EXTRACT_DIR"
  write_files "$APP_EXTRACT_DIR"
  ok "Web files extracted to ${APP_EXTRACT_DIR}. Test e.g. with: python3 -m http.server -d ${APP_EXTRACT_DIR} 8080"
}
@@END@@
@@IF server@@
installed_or_die() { [ -f "${APP_ROOT}/VERSION" ] || die "${APP_NAME} is not installed here."; }

do_backup() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo or as root."
  installed_or_die
  keep_settings >/dev/null
  backup_now
}

do_list_backups() {
  [ -d "$APP_BACKUP_DIR" ] && ls -1t "${APP_BACKUP_DIR}/${APP_ID}-"*.dump 2>/dev/null | while read -r f; do
    printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "$f"
  done || true
  [ -n "$(ls -A "${APP_BACKUP_DIR}" 2>/dev/null)" ] || echo "  No backups in ${APP_BACKUP_DIR} yet."
}

do_restore() {
  [ "$(id -u)" -eq 0 ] || die "Please run with sudo or as root."
  installed_or_die
  keep_settings >/dev/null
  [ -s "$APP_RESTORE_FILE" ] || die "No such backup: ${APP_RESTORE_FILE} (list them with --list-backups)"
  pg_restore --list "$APP_RESTORE_FILE" >/dev/null 2>&1 || die "${APP_RESTORE_FILE} is not a backup made with --backup."
  say "Backing up the current state first"
  backup_now
  systemctl stop "${APP_SERVICE}.service"
  say "Restoring ${APP_RESTORE_FILE}"
  if local_db; then
    as_postgres psql -qc "drop database \"${APP_ID}\"" >/dev/null
    as_postgres psql -qc "create database \"${APP_ID}\" owner \"${APP_USER}\" encoding 'UTF8' template template0" >/dev/null
    as_postgres pg_restore --no-owner --role="${APP_USER}" -d "$APP_ID" < "$APP_RESTORE_FILE" || die "Restore failed. The backup of the state before is $(cat "${APP_BACKUP_DIR}/.last")"
  else
    pg_restore --clean --if-exists --no-owner -d "$APP_DB_URL" "$APP_RESTORE_FILE" || die "Restore failed. The backup of the state before is $(cat "${APP_BACKUP_DIR}/.last")"
  fi
  start_service
  ok "Restored. The state before is in $(cat "${APP_BACKUP_DIR}/.last")"
}
@@END@@

case "$APP_ACTION" in
  install)   do_install ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
@@IF static@@
  extract)   do_extract ;;
@@END@@
@@IF server@@
  backup)    do_backup ;;
  restore)   do_restore ;;
  list-backups) do_list_backups ;;
@@END@@
esac
