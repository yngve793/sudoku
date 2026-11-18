# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# Production bundle talks to the real API; never ship the MSW mocks.
ENV VITE_USE_MOCKS=false
RUN npm run build && rm -f dist/mockServiceWorker.js

# ---------- runtime ----------
# Unprivileged nginx: runs as a non-root user, so it listens on 8080 (not 80).
FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
