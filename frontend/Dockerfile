# syntax=docker/dockerfile:1.7
#
# Targets:
#   runtime (default)  nginx-unprivileged serving the built SPA and proxying /api/ to api:8000
#   dev                Vite dev server (used by compose.dev.yml; source is bind-mounted)

# ---------- deps: npm ci, cached until the lockfile changes ----------
FROM node:22.23-alpine AS deps
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
    npm ci --no-audit --no-fund

# ---------- dev: Vite dev server with HMR ----------
FROM deps AS dev
ENV VITE_USE_MOCKS=false
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]

# ---------- build ----------
FROM deps AS build
COPY --chown=node:node . .
# Production bundle talks to the real API; never ship the MSW mocks.
ENV VITE_USE_MOCKS=false
RUN npm run build && rm -f dist/mockServiceWorker.js

# ---------- runtime ----------
# Unprivileged nginx: runs as a non-root user (uid 101), so it listens on 8080 (not 80).
FROM nginxinc/nginx-unprivileged:1.30-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
