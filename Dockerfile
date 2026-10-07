# Overlook: one image, a Hono backend serving the built React page. Your lab's config is mounted, never baked in:
#   docker run -v ./config:/config:ro --env-file .env -p 8080:8080 ghcr.io/trialskid/overlook
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY shared ./shared
COPY server ./server
RUN npm run build

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
# HOMELAB_CONFIG: your homelab.json (mount the folder: an editor that saves it as a new file is still seen).
# Clock times follow homelab.json `timezone`, else TZ (set it in .env), else UTC.
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data HOMELAB_CONFIG=/config/homelab.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# the example lab, to start from (and for MOCK=1 HOMELAB_CONFIG=/app/config/example.homelab.json, a demo)
COPY config/example.homelab.json ./config/example.homelab.json
RUN mkdir -p /data /config && chown node:node /data
USER node
EXPOSE 8080
# /healthz turns 503 when no snapshot has been built for 2 min or every source has been failing for 2 min
# (it has its own 2 min start grace). The reason is in the response body: docker inspect shows it.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(async r => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
