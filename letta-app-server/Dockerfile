ARG NODE_BASE_VERSION=22.22-alpine
FROM node:${NODE_BASE_VERSION}

# ---------------------------------------------------------------------
# Self-hosted Letta App Server.
#
# The App Server is not a separate distribution: it is a mode of the Letta
# Code CLI —
#
#     letta server --listen ws://0.0.0.0:4500
#
# so this image is the pinned `@letta-ai/letta-code` package plus an
# entrypoint that materialises the capability token and the persistent
# state directory.
#
# It speaks WebSocket, not REST, and is reachable only from
# evaself-network. The single client is eva-agent-service, which drives it
# through the official Agent SDK.
# ---------------------------------------------------------------------
ARG LETTA_CODE_VERSION=0.29.8

ENV LETTA_HOME=/data/letta \
    LETTA_LOCAL_BACKEND_DIR=/data/letta/lc-local-backend \
    HOME=/data/letta \
    NODE_ENV=production

RUN apk add --no-cache ca-certificates git ripgrep tini curl \
 && npm install -g "@letta-ai/letta-code@${LETTA_CODE_VERSION}" \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# All state — agents, conversations, the memory filesystem — lives here and
# is a named volume, so `make backup` can capture it.
RUN mkdir -p /data/letta && chown -R node:node /data
VOLUME ["/data/letta"]

USER node
WORKDIR /data/letta

EXPOSE 4500

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
