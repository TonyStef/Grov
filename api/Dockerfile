# Grov API Dockerfile
# Build from monorepo root: docker build -f api/Dockerfile -t grov-api .

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json postinstall.js ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
RUN pnpm install --frozen-lockfile --filter @grov/api --filter @grov/shared

# Build shared types first, then API
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY shared ./shared
COPY api ./api
COPY tsconfig.json ./

# Build shared package
WORKDIR /app/shared
RUN pnpm build

# Build API
WORKDIR /app/api
RUN pnpm build

# Production image - install fresh prod deps only
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy package.json, remove workspace dep, install prod deps only
COPY api/package.json ./
RUN sed -i '/"@grov\/shared"/d' package.json && npm install --omit=dev

# Copy built files
COPY --from=builder /app/api/dist ./dist

# Cloud Run uses PORT env var
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
