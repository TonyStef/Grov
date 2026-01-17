# Grov Landing Dockerfile
# Build from monorepo root: docker build -f landing/Dockerfile -t grov-landing .

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY landing/package.json ./landing/
RUN pnpm install --frozen-lockfile --filter grov-landing

# Build the site
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/landing/node_modules ./landing/node_modules
COPY landing ./landing
COPY tsconfig.json ./

WORKDIR /app/landing
RUN pnpm build

# Production stage - Nginx serving static files
FROM nginx:alpine AS runner

# Copy built static files to Nginx
COPY --from=builder /app/landing/dist /usr/share/nginx/html

# Copy custom nginx config for SPA routing
COPY landing/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
