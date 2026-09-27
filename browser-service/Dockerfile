ARG PLAYWRIGHT_BASE_IMAGE=mcr.microsoft.com/playwright
ARG PLAYWRIGHT_BASE_VERSION=v1.63.0-noble

# ---------------------------------------------------------------------
# browser-service — изолированный Chromium для Евы (Playwright).
#
# Базовый образ Playwright несёт Chromium той ревизии, которую ждёт
# playwright-core той же версии, и его системные библиотеки: скачивания
# браузера при сборке нет. Версия пакета и тег образа совпадают
# (versions.env) — иначе playwright-core не найдёт свой Chromium.
# ---------------------------------------------------------------------
FROM ${PLAYWRIGHT_BASE_IMAGE}:${PLAYWRIGHT_BASE_VERSION} AS build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Тесты — в том же образе, что и рантайм: настоящий Chromium, настоящий
# прокси. `docker build --target test .`
FROM build AS test
COPY test ./test
ENV EVA_ENV=test
RUN node --test --test-reporter=spec test/*.test.mjs

FROM ${PLAYWRIGHT_BASE_IMAGE}:${PLAYWRIGHT_BASE_VERSION} AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BROWSER_SERVICE_PORT=8098 \
    HOME=/tmp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Непривилегированный пользователь образа Playwright. Песочницей
# Chromium служит сам контейнер: корень только для чтения, без
# capabilities, без no-new-privileges-эскалации и в отдельной сети.
USER pwuser
EXPOSE 8098
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8098/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
