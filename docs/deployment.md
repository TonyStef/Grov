# Grov Deployment Documentation

> Complete deployment guide for Grov API and Dashboard to Google Cloud Run

## Architecture Overview

```
                    ┌─────────────────────────────────────────────────────┐
                    │                  Google Cloud Run                    │
                    │                   (europe-west1)                     │
                    │  ┌─────────────────┐    ┌──────────────────────┐    │
                    │  │   grov-api      │    │   grov-dashboard     │    │
                    │  │   (Fastify)     │    │   (Next.js 16)       │    │
                    │  │   Port 8080     │    │   Port 8080          │    │
                    │  └────────┬────────┘    └──────────┬───────────┘    │
                    └───────────┼─────────────────────────┼───────────────┘
                                │                         │
                                └───────────┬─────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────┐
                              │    Supabase (Ireland)    │
                              │    PostgreSQL + Auth     │
                              │    Row Level Security    │
                              └──────────────────────────┘
```

**Services:**
- **grov-api**: Fastify backend API (handles CLI auth, team sync, memories CRUD)
- **grov-dashboard**: Next.js frontend (team management, memories viewer, settings)

**Database:**
- **Supabase**: PostgreSQL with RLS, hosted in West EU (Ireland)

---

## Accounts & Credentials

### Google Cloud Platform
- **Project ID**: `grov-prod`
- **Project Name**: Grov Production
- **Region**: `europe-west1` (Belgium - close to Ireland Supabase)
- **Billing**: Free trial with $300 credits (expires March 2026)
- **Account**: stefvirgil2006@gmail.com

### Supabase
- **Project ID**: `kjaytyvimxbnvsqlmzga`
- **Region**: West EU (Ireland)
- **URL**: `https://kjaytyvimxbnvsqlmzga.supabase.co`

### Secrets (stored in Bitwarden)
- `Grov API - JWT Secret (Production)` - For API token signing
- `Grov API - Supabase Service Key (Production)` - service_role key

---

## Prerequisites

### 1. Install gcloud CLI (macOS)
```bash
brew install google-cloud-sdk

# For Apple Silicon (M1/M2/M3), set Python 3.13:
export CLOUDSDK_PYTHON=$(brew --prefix python@3.13)/bin/python3.13

# Add to ~/.zshrc for persistence:
echo 'export CLOUDSDK_PYTHON=$(brew --prefix python@3.13)/bin/python3.13' >> ~/.zshrc

# Source the path
source /opt/homebrew/share/google-cloud-sdk/path.zsh.inc
```

### 2. Authenticate
```bash
gcloud auth login
gcloud config set project grov-prod
```

### 3. Configure Docker for GCP
```bash
gcloud auth configure-docker europe-west1-docker.pkg.dev
```

---

## Supabase Production Setup

### Tables Required
The production database has these tables:
- `profiles` - User profiles (synced from auth.users)
- `teams` - Team records
- `team_members` - Team membership (user_id, team_id, role)
- `team_invitations` - Invite codes with expiry
- `memories` - Synced tasks/memories from CLI
- `api_tokens` - CLI authentication tokens

### Critical: RLS Helper Functions
These SECURITY DEFINER functions prevent RLS infinite recursion:

```sql
-- Check team membership (bypasses RLS)
CREATE OR REPLACE FUNCTION is_team_member(check_team_id UUID, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = check_team_id AND user_id = check_user_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check admin role
CREATE OR REPLACE FUNCTION is_team_admin(check_team_id UUID, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = check_team_id
    AND user_id = check_user_id
    AND role IN ('admin', 'owner')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Check owner role
CREATE OR REPLACE FUNCTION is_team_owner(check_team_id UUID, check_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM team_members
    WHERE team_id = check_team_id
    AND user_id = check_user_id
    AND role = 'owner'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Unique Constraint for Sync
Prevents duplicate memories when CLI syncs:
```sql
ALTER TABLE memories
ADD CONSTRAINT memories_team_client_task_unique
UNIQUE (team_id, client_task_id);
```

---

## Dockerfiles Explained

### API Dockerfile (`api/Dockerfile`)

**Strategy**: Multi-stage build with fresh npm install in runner stage.

```dockerfile
# Stage 1: Base - Enable pnpm
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Stage 2: Deps - Install workspace dependencies
FROM base AS deps
# Uses --filter to only install @grov/api and @grov/shared deps
RUN pnpm install --frozen-lockfile --filter @grov/api --filter @grov/shared

# Stage 3: Builder - Compile TypeScript
FROM base AS builder
# Build shared package first (API imports types from it)
# Then build API

# Stage 4: Runner - Production image
FROM node:20-alpine AS runner
# Remove @grov/shared from package.json (it's types-only, erased at compile)
# Install ONLY production deps with npm (no devDependencies)
RUN sed -i '/"@grov\/shared"/d' package.json && npm install --omit=dev
```

**Why fresh npm install?**
- pnpm uses symlinks that don't copy properly between Docker stages
- `npm install --omit=dev` = production dependencies only
- `sed` removes workspace:* dependency (types are erased at compile time)

### Dashboard Dockerfile (`dashboard/Dockerfile`)

**Strategy**: Multi-stage build with Next.js standalone output.

```dockerfile
# Build args for client-side env vars (baked at build time)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN pnpm build

# Runner stage - preserve standalone structure for correct module resolution
FROM node:20-alpine AS runner
WORKDIR /app

# Copy entire standalone folder (preserves node_modules at correct relative path)
COPY --from=builder --chown=nextjs:nodejs /app/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/dashboard/.next/static ./dashboard/.next/static
COPY --from=builder /app/dashboard/public ./dashboard/public

WORKDIR /app/dashboard
CMD ["node", "server.js"]
```

**Key points:**
- `output: 'standalone'` in next.config.ts creates self-contained build
- `NEXT_PUBLIC_*` vars must be passed as build args (not runtime env)
- **Critical**: Copy entire standalone folder to preserve relative paths
- server.js expects `../node_modules/next` - must preserve this structure
- WORKDIR must be `/app/dashboard` where server.js lives
- Static files go to `./dashboard/.next/static` (relative to standalone root)

### next.config.ts Settings

```typescript
const nextConfig: NextConfig = {
  output: 'standalone',           // Required for Docker
  transpilePackages: ['@grov/shared'],
  turbopack: {
    root: '..',                   // Fix workspace detection in Docker
  },
};
```

---

## Build Commands

### Build API (from monorepo root)
```bash
docker build --platform linux/amd64 \
  -f api/Dockerfile \
  -t europe-west1-docker.pkg.dev/grov-prod/grov/api:latest \
  .
```

### Build Dashboard (from monorepo root)
```bash
docker build --platform linux/amd64 \
  -f dashboard/Dockerfile \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://kjaytyvimxbnvsqlmzga.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key_from_supabase> \
  -t europe-west1-docker.pkg.dev/grov-prod/grov/dashboard:latest \
  .
```

**Important flags:**
- `--platform linux/amd64` - Required on Apple Silicon (M1/M2/M3)
- Cloud Run runs on AMD64, not ARM
- Without this flag, deployment fails with "must support amd64/linux"

---

## Push to Artifact Registry

```bash
# Push API
docker push europe-west1-docker.pkg.dev/grov-prod/grov/api:latest

# Push Dashboard
docker push europe-west1-docker.pkg.dev/grov-prod/grov/dashboard:latest
```

---

## Deploy to Cloud Run

### Deploy API
```bash
gcloud run deploy grov-api \
  --image=europe-west1-docker.pkg.dev/grov-prod/grov/api:latest \
  --region=europe-west1 \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="SUPABASE_URL=https://kjaytyvimxbnvsqlmzga.supabase.co,SUPABASE_SERVICE_ROLE_KEY=<service_role_key>,JWT_SECRET=<jwt_secret>,CORS_ORIGIN=https://app.grov.dev"
```

### Deploy Dashboard
```bash
gcloud run deploy grov-dashboard \
  --image=europe-west1-docker.pkg.dev/grov-prod/grov/dashboard:latest \
  --region=europe-west1 \
  --platform=managed \
  --allow-unauthenticated
```

**Note**: Dashboard doesn't need env vars - Supabase keys were baked in at build time.

---

## Environment Variables

### API (Runtime)
| Variable | Description | Example |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) | `eyJ...` |
| `JWT_SECRET` | Secret for signing API tokens (32+ chars) | `WEDhTx...` |
| `CORS_ORIGIN` | Allowed origin for CORS | `https://app.grov.dev` |
| `DASHBOARD_URL` | Dashboard URL for device auth flow | `https://app.grov.dev` |
| `PORT` | Auto-set by Cloud Run | `8080` |

### Dashboard (Build-time)
| Variable | Description | Passed as |
|----------|-------------|-----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `--build-arg` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (safe for client) | `--build-arg` |

### Dashboard (Runtime)
| Variable | Description | Example |
|----------|-------------|---------|
| `APP_URL` | Dashboard URL for invite links | `https://app.grov.dev` |

---

## Deploy Scripts

Simplified deployment using scripts in `scripts/`:

```bash
# Deploy dashboard (build, push, deploy)
./scripts/deploy-dashboard.sh

# Deploy API (build, push, deploy)
./scripts/deploy-api.sh
```

---

## Required RLS Policies

These policies must be added in Supabase for the dashboard to work:

### team_invitations
```sql
-- Allow anyone to view invitation by code (needed for join flow)
CREATE POLICY "Anyone can view invitation by code"
ON team_invitations FOR SELECT USING (true);
```

### profiles
```sql
-- Allow team members to view each other's profiles
CREATE POLICY "Team members can view each other's profiles"
ON profiles FOR SELECT
USING (
  id IN (
    SELECT tm.user_id FROM team_members tm
    WHERE tm.team_id IN (
      SELECT team_id FROM team_members WHERE user_id = auth.uid()
    )
  )
);
```

### Profile Sync (run once after users sign up via OAuth)
```sql
-- Sync GitHub profile data to profiles table
INSERT INTO profiles (id, email, full_name, avatar_url)
SELECT
  id,
  email,
  COALESCE(raw_user_meta_data->>'name', raw_user_meta_data->>'user_name', email),
  raw_user_meta_data->>'avatar_url'
FROM auth.users
ON CONFLICT (id) DO UPDATE SET
  full_name = EXCLUDED.full_name,
  avatar_url = EXCLUDED.avatar_url;
```

---

## Useful Commands

### View Services
```bash
# List all Cloud Run services
gcloud run services list --region=europe-west1

# Get service details
gcloud run services describe grov-api --region=europe-west1
gcloud run services describe grov-dashboard --region=europe-west1
```

### View Logs
```bash
# Stream live logs
gcloud run services logs read grov-api --region=europe-west1 --limit=50

# Or use logging read for more detail
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=grov-api" --limit=50
```

### Update Environment Variables
```bash
gcloud run services update grov-api \
  --region=europe-west1 \
  --set-env-vars="KEY=value"
```

### Delete Service
```bash
gcloud run services delete grov-api --region=europe-west1
gcloud run services delete grov-dashboard --region=europe-west1
```

### View Artifact Registry Images
```bash
# List images
gcloud artifacts docker images list europe-west1-docker.pkg.dev/grov-prod/grov

# Delete old images (keep latest)
gcloud artifacts docker images delete europe-west1-docker.pkg.dev/grov-prod/grov/api:latest
```

### Clean Local Docker
```bash
# Remove all unused images and build cache
docker system prune -a

# Check disk usage
docker system df
```

---

## Service URLs

| Service | Cloud Run URL | Custom Domain (pending) |
|---------|---------------|-------------------------|
| API | `https://grov-api-488506670146.europe-west1.run.app` | `api.grov.dev` |
| Dashboard | `https://grov-dashboard-488506670146.europe-west1.run.app` | `app.grov.dev` |

### Health Checks
```bash
# API health
curl https://grov-api-488506670146.europe-west1.run.app/health
# Returns: {"status":"ok","timestamp":"..."}

# Dashboard (just load the page)
curl -I https://grov-dashboard-488506670146.europe-west1.run.app
# Returns: HTTP/2 200
```

### Deployed: December 6, 2025

---

## Troubleshooting

### "Container failed to start on port 8080"
1. Check logs: `gcloud run services logs read <service> --region=europe-west1`
2. Common causes:
   - Missing environment variables
   - Module not found (check Dockerfile COPY paths)
   - Wrong CMD path

### "Must support amd64/linux"
Build was done on Apple Silicon without `--platform linux/amd64` flag.
```bash
docker build --platform linux/amd64 ...
```

### "Cannot find module"
- For API: Check that `npm install --omit=dev` includes the module
- For Dashboard: Check standalone path (`standalone/dashboard/` in monorepo)

### "ERR_MODULE_NOT_FOUND: dotenv"
The Dockerfile wasn't copying node_modules properly. Use fresh npm install in runner stage.

### TypeScript errors in Docker build only
Production builds are stricter. Add type annotations:
```typescript
setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[])
```

### "turbopack.root should be absolute"
Add to next.config.ts:
```typescript
turbopack: {
  root: '..',
}
```

### Auth callback redirects to 0.0.0.0:8080
Cloud Run forwards requests to the container, and `request.url` returns the internal container URL instead of the external URL. Fix in `src/app/auth/callback/route.ts`:
```typescript
// Use forwarded host header (set by Cloud Run/proxies)
const forwardedHost = request.headers.get('x-forwarded-host');
const forwardedProto = request.headers.get('x-forwarded-proto') || 'https';
const origin = forwardedHost
  ? `${forwardedProto}://${forwardedHost}`
  : new URL(request.url).origin;
```

### "Invalid API key" error on auth
The Supabase ANON_KEY was corrupted (newlines inserted when copying long strings in terminal). Solutions:
1. Use `scripts/build-dashboard.sh` which has the correct key stored
2. Never copy long keys directly into terminal - use environment variables or scripts
3. Use `--no-cache` flag when rebuilding to ensure fresh build with new env vars
4. Verify key in Supabase Dashboard → Settings → API matches what's in build script

### Domain mapping SSL stuck on "Certificate Pending"
Google Cloud Run SSL provisioning can take 15-30 minutes. If stuck:
1. Verify CNAME points to `ghs.googlehosted.com` (not the Cloud Run URL)
2. Ensure Cloudflare proxy is OFF (gray cloud, DNS only)
3. Turn OFF "Always Use HTTPS" in Cloudflare SSL/TLS → Edge Certificates
4. Check status: `gcloud beta run domain-mappings describe --domain=DOMAIN --region=europe-west1`
5. If still stuck after 30 min, delete and recreate the mapping

---

## Cost Estimate

| Resource | Cost |
|----------|------|
| Cloud Run (idle) | $0 (scales to zero) |
| Cloud Run (per request) | ~$0.00001 |
| Artifact Registry | ~$0.10/GB/month |
| **Monthly estimate** | **$0-5** (low traffic) |

Free tier includes:
- 2 million requests/month
- 360,000 GB-seconds compute
- 1 GB egress

---

## Deployment Checklist

- [ ] gcloud CLI installed and authenticated
- [ ] Docker Desktop running
- [ ] Supabase production database ready with RLS
- [ ] Secrets stored in Bitwarden
- [ ] Build with `--platform linux/amd64`
- [ ] Push images to Artifact Registry
- [ ] Deploy with correct environment variables
- [ ] Test health endpoint
- [ ] Configure custom domains (Cloudflare + Cloud Run domain mappings)
- [ ] Update Supabase Site URL to production domain
- [ ] Update GitHub OAuth Homepage URL to production domain
- [ ] Update API CORS_ORIGIN to production domain

---

## Custom Domain Setup (Completed)

**Cloudflare DNS Configuration:**
| Name | Type | Target | Proxy |
|------|------|--------|-------|
| `api` | CNAME | `ghs.googlehosted.com` | DNS only (gray) |
| `app` | CNAME | `ghs.googlehosted.com` | DNS only (gray) |

**Cloud Run Domain Mappings:**
```bash
gcloud beta run domain-mappings create --service=grov-api --domain=api.grov.dev --region europe-west1
gcloud beta run domain-mappings create --service=grov-dashboard --domain=app.grov.dev --region europe-west1
```

**Post-Domain Setup:**
1. Update API CORS: `gcloud run services update grov-api --region=europe-west1 --update-env-vars="CORS_ORIGIN=https://app.grov.dev"`
2. Update GitHub OAuth Homepage URL to `https://app.grov.dev`
3. Update Supabase Auth URL Configuration:
   - Site URL: `https://app.grov.dev`
   - Redirect URLs: `https://app.grov.dev`, `https://app.grov.dev/**`
