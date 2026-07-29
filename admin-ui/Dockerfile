ARG CADDY_IMAGE=caddy
ARG CADDY_VERSION=2.10.2-alpine
FROM ${CADDY_IMAGE}:${CADDY_VERSION}

COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv

EXPOSE 8083

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8083/healthz || exit 1
