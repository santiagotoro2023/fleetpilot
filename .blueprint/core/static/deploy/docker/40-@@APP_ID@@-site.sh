#!/bin/sh
# Runs before nginx starts: writes site.json (version and public address) into /tmp,
# so the image works with a read-only root file system.
set -eu
dir=/tmp/@@APP_ID@@
mkdir -p "$dir"
port="${@@APP_ENV@@_PORT:-8080}"
echo "listen ${port};" > "$dir/listen.conf"
# IPv6 only where the kernel has it: some clusters and Docker networks do not
if [ -f /proc/net/if_inet6 ] && [ -s /proc/net/if_inet6 ]; then echo "listen [::]:${port};" >> "$dir/listen.conf"; fi
canonical="${@@APP_ENV@@_CANONICAL:-}"
canonical="${canonical%/}"
if [ -n "$canonical" ] && ! printf '%s' "$canonical" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'; then
  echo "@@APP_ID@@: ignoring @@APP_ENV@@_CANONICAL='$canonical' (expected e.g. https://@@APP_ID@@.example.com, without a path)" >&2
  canonical=""
fi
if [ -n "$canonical" ]; then
  printf '{ "version": "%s", "canonical": "%s" }\n' "${@@APP_ENV@@_VERSION:-dev}" "$canonical" > "$dir/site.json"
else
  printf '{ "version": "%s" }\n' "${@@APP_ENV@@_VERSION:-dev}" > "$dir/site.json"
fi
echo "@@APP_ID@@: version ${@@APP_ENV@@_VERSION:-dev}${canonical:+, public address $canonical}"
