ARG NODE_BASE_VERSION=22.22-alpine

# ---------------------------------------------------------------------
# Build stage: install everything, compile TypeScript, run the tests.
# ---------------------------------------------------------------------
FROM node:${NODE_BASE_VERSION} AS build

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

RUN npm run build && node --test --experimental-strip-types test/*.test.ts

# Drop dev dependencies from the tree that ships.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------
FROM node:${NODE_BASE_VERSION}

# The Agent SDK requires Node >= 22.19.
ENV NODE_ENV=production \
    EVA_AGENT_PORT=8070

RUN apk add --no-cache tini

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 8070

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.EVA_AGENT_PORT||8070)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
