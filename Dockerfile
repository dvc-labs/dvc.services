FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:25-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:25-bookworm-slim AS runtime
ENV NODE_ENV=production \
    TZ=Europe/Brussels \
    PORT=8080 \
    NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY --chown=node:node package.json package-lock.json LICENSE ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
