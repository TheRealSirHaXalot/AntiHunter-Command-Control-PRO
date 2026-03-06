# syntax=docker/dockerfile:1.7

FROM node:20-bookworm AS deps
WORKDIR /app

ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@8.15.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/

# Install workspace dependencies (dev deps needed for build)
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .

# Generate Prisma client and build the NestJS backend
RUN pnpm --filter @command-center/backend prisma:generate  && pnpm --filter @command-center/backend build

FROM node:20.19.6-trixie-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN corepack prepare pnpm@8.15.4 --activate

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

# Generate Prisma client: prisma CLI is a devDep, use npx to fetch it temporarily
RUN npx -y prisma@5.22.0 generate --schema=apps/backend/prisma/schema.prisma \
    && rm -rf /root/.npm/_npx

# Provide udevadm for serialport enumeration inside the container
RUN apt-get update  && apt-get install -y --no-install-recommends udev  && rm -rf /var/lib/apt/lists/*

# Copy backend artefacts
COPY --from=builder /app/apps/backend ./apps/backend

# Lightweight entrypoint handles migrations before boot
COPY docker/backend-entrypoint.sh ./backend-entrypoint.sh
RUN chmod +x ./backend-entrypoint.sh

EXPOSE 3000

CMD ["./backend-entrypoint.sh"]
