ARG NODE_BASE_VERSION=22.22-bookworm-slim
ARG DOCKER_CLI_IMAGE=docker
ARG DOCKER_CLI_VERSION=28.5.2-cli

FROM ${DOCKER_CLI_IMAGE}:${DOCKER_CLI_VERSION} AS docker-cli

# ---------------------------------------------------------------------
# Build stage: install everything, compile TypeScript, run the tests.
# ---------------------------------------------------------------------
FROM node:${NODE_BASE_VERSION} AS build

WORKDIR /app
ENV NODE_ENV=development

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN npm run build && node --test --experimental-strip-types test/*.test.ts

# Drop dev dependencies from the tree that ships.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------
FROM node:${NODE_BASE_VERSION} AS runtime

# The Agent SDK requires Node >= 22.19.
ENV NODE_ENV=production \
    EVA_AGENT_PORT=8070

RUN apt-get update \
 && apt-get install -y --no-install-recommends git gosu openssl tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/evaself-entrypoint

RUN mkdir -p /data/letta-config/providers /data/llm-control \
 && chown -R node:node /data/letta-config /data/llm-control \
 && chmod 0755 /usr/local/bin/evaself-entrypoint

# Выделенная группа для Unix-сокета updater. Сокет создаёт eva-updater
# (работает от root), а ходят в него admin-api и health-worker, которые
# entrypoint переводит на пользователя node. Раньше сокет был 0666, то
# есть доступен любому процессу в любом контейнере, монтирующем этот
# volume. Группа позволяет отдать права 0660 и не сломать клиентов.
RUN groupadd --system evaself-updater \
 && usermod -aG evaself-updater node

EXPOSE 8070

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.EVA_AGENT_PORT||8070)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/evaself-entrypoint"]
CMD ["node", "dist/index.js"]

# Docker CLI и Compose нужны только доверенному updater-процессу для
# фиксированных backup/update-скриптов. Обычный Agent Runtime и admin-api
# собираются из финального target `app` и этих бинарников не получают.
FROM runtime AS updater
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins \
    /usr/local/libexec/docker/cli-plugins

FROM runtime AS app
