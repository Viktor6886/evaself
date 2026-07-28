ARG CADDY_IMAGE=caddy
ARG CADDY_VERSION=2.11.4-alpine
FROM ${CADDY_IMAGE}:${CADDY_VERSION}

# ---------------------------------------------------------------------
# Evaself Letta console.
#
# Letta 0.16.x does NOT ship a self-hosted web UI: the server mounts only
# a redirect from "/" to "/docs", and the official ADE is the hosted
# application at app.letta.com. This container is Evaself's own console —
# a static client plus a Caddy reverse proxy that injects the Letta server
# password, so the Letta REST API itself is never exposed to the internet.
#
# See letta-ui/README.md for the reasoning and for how to use the official
# cloud ADE against this server instead, if you prefer it.
# ---------------------------------------------------------------------
COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
