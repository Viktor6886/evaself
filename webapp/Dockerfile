ARG CADDY_IMAGE=caddy
ARG CADDY_VERSION=2.11.4-alpine
FROM ${CADDY_IMAGE}:${CADDY_VERSION}

# ---------------------------------------------------------------------
# Static front-end: the public landing page and Eva's Telegram Mini App.
# No build step and no Node runtime — the assets are plain files, served
# by the same Caddy version the edge uses.
# ---------------------------------------------------------------------
COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8082/healthz || exit 1
