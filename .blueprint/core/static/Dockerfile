# @@APP_NAME@@ as a container: nginx without root serves the static web app.
# Everything users do is stored in their own browser, so the container is
# stateless: any number of replicas, no volume, no database.
#
#   docker build -t @@APP_ID@@ .
#   docker run -d -p 8080:8080 @@APP_ID@@          then open http://localhost:8080
#
# Settings (environment variables):
#   @@APP_ENV@@_CANONICAL   the public address, e.g. https://@@APP_ID@@.example.com.
#                           Share links point there, and if users open @@APP_NAME@@
#                           under another address they are offered to move their data.
FROM nginxinc/nginx-unprivileged:1.27-alpine

ARG VERSION=dev
LABEL org.opencontainers.image.title="@@APP_NAME@@" \
      org.opencontainers.image.description="@@APP_DESCRIPTION@@" \
      org.opencontainers.image.source="https://github.com/@@APP_REPO@@" \
      org.opencontainers.image.version="${VERSION}"

ENV @@APP_ENV@@_VERSION="${VERSION}" \
    @@APP_ENV@@_CANONICAL=""

USER root
COPY src/ /usr/share/nginx/html/
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 deploy/docker/40-@@APP_ID@@-site.sh /docker-entrypoint.d/40-@@APP_ID@@-site.sh
RUN rm -f /usr/share/nginx/html/site.json /usr/share/nginx/html/package.json \
 && chmod -R a+rX /usr/share/nginx/html
USER 101

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
