ARG CADDY_IMAGE=caddy
ARG CADDY_VERSION=2.11.4-alpine
FROM ${CADDY_IMAGE}:${CADDY_VERSION}

# ---------------------------------------------------------------------
# Evaself Letta console.
#
# Two facts decide the shape of this container:
#
#   1. Letta ships no self-hosted web UI. `letta-oss-ui` does not exist as
#      a published package (npm returns 404 for both `letta-oss-ui` and
#      `@letta-ai/letta-oss-ui`), and the App Server serves no HTML.
#   2. The App Server's only interface is a WebSocket protocol driven by
#      @letta-ai/letta-agent-sdk, which is a Node SDK — a browser cannot
#      be its client.
#
# So this is Evaself's own administrative interface: a static client that
# reads through eva-agent-service, which owns the SDK. See README.md.
# ---------------------------------------------------------------------
COPY Caddyfile /etc/caddy/Caddyfile
COPY public /srv

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1
