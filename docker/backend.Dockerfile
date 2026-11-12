# syntax=docker/dockerfile:1.7

FROM node:24.22.3-bookworm AS deps
WORKDIR /app

ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@12.4.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/

# Install workspace dependencies (dev deps needed for build)
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .

RUN pnpm --filter @command-center/backend prisma:generate \
  && pnpm --filter @command-center/backend build \
  && pnpm --filter @command-center/backend exec tsc -p tsconfig.seed.json --noEmit false

FROM node:24.22.3-trixie-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@12.4.2 --activate

# Copy workspace metadata so pnpm can resolve symlinks
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.base.json ./tsconfig.base.json
RUN mkdir -p apps/backend
COPY --from=builder /app/apps/backend/prisma ./apps/backend/prisma
COPY --from=builder /app/apps/backend/package.json ./apps/backend/package.json

# Install production dependencies only for @command-center/backend
RUN pnpm install --frozen-lockfile --prod --filter @command-center/backend...

ENV npm_config_cache=/app/.npm-cache

# Provide udevadm and git inside the container
RUN apt-get update  && apt-get install -y --no-install-recommends udev git  && rm -rf /var/lib/apt/lists/*

# Copy backend artefacts
COPY --from=builder /app/apps/backend ./apps/backend
COPY --from=builder /app/scripts/db-update-helper.mjs ./scripts/db-update-helper.mjs

# Regenerate the Prisma client against the prod-installed @prisma/client
RUN pnpm --filter @command-center/backend exec prisma generate \
  && pnpm --filter @command-center/backend exec prisma version

# Lightweight entrypoint handles migrations before boot
COPY docker/backend-entrypoint.sh ./backend-entrypoint.sh
RUN sed -i 's/\r$//' ./backend-entrypoint.sh && chmod +x ./backend-entrypoint.sh

RUN mkdir -p /app/data/tiles /app/apps/backend/.secrets /app/.npm-cache \
  && chown -R node:node /app/apps/backend /app/data /app/.npm-cache \
    /app/node_modules/.pnpm/prisma@* /app/node_modules/.pnpm/@prisma+client@*

EXPOSE 3000

CMD ["./backend-entrypoint.sh"]
