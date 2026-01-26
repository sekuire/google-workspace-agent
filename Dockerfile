# Production Build - Sekuire Google Workspace Agent
#
# USAGE (two options):
#
# Option 1 - Build from repo root (recommended for development):
#   docker build -f agents/google-workspace-agent/Dockerfile -t sekuire/google-workspace-agent .
#
# Option 2 - Standalone build (uses published SDK):
#   cd agents/google-workspace-agent && docker build -t sekuire/google-workspace-agent .
#   Note: Requires @sekuire/sdk to be published to npm

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml* ./

# Install dependencies - will use published @sekuire/sdk from npm
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apk add --no-cache curl

RUN addgroup -g 1001 sekuire && adduser -S sekuire -u 1001

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod 2>/dev/null || pnpm install --prod

COPY --from=builder --chown=sekuire:sekuire /app/dist ./dist
COPY --chown=sekuire:sekuire prompts ./prompts
COPY --chown=sekuire:sekuire sekuire.yml tools.json ./

USER sekuire

ENV NODE_ENV=production
ENV PORT=8002
EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8002/health || exit 1

CMD ["node", "dist/index.js"]
