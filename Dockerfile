# RSSify — Node >=25 native TypeScript type-stripping, no build step.
# Two-stage build: compile native deps (better-sqlite3) in the builder,
# runtime image stays slim.
# syntax=docker/dockerfile:1

FROM node:25-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:25-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
# Secrets are NOT baked in: mount config.yaml + .env (see docker-compose.yml).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/cli.ts", "serve"]
