# Grov Dashboard Dockerfile
# Build from monorepo root: docker build -f dashboard/Dockerfile -t grov-dashboard .

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/package.json ./shared/
COPY dashboard/package.json ./dashboard/
RUN pnpm install --frozen-lockfile --filter @grov/dashboard --filter @grov/shared

# Build shared types first, then Dashboard
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/dashboard/node_modules ./dashboard/node_modules
COPY shared ./shared
COPY dashboard ./dashboard
COPY tsconfig.json ./

# Build shared package
WORKDIR /app/shared
RUN pnpm build

# Build Dashboard
WORKDIR /app/dashboard

# Build args for Next.js public env vars (set at build time)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN pnpm build

# Production image
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built assets - preserve standalone structure for correct module resolution
COPY --from=builder --chown=nextjs:nodejs /app/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/dashboard/.next/static ./dashboard/.next/static
COPY --from=builder /app/dashboard/public ./dashboard/public

USER nextjs

WORKDIR /app/dashboard

# Cloud Run uses PORT env var
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
