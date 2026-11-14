# Build context is the repo root:
#   docker build -f apps/landing/Dockerfile .
FROM node:24-slim AS base

RUN corepack enable

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/stator/package.json ./packages/stator/
# The CLI's bin target, so the install can link `stator` into node_modules/.bin;
# the rest of the source arrives in the runtime stage.
COPY packages/stator/src/cli/stator.js ./packages/stator/src/cli/
COPY apps/landing/package.json ./apps/landing/

RUN CI=true pnpm install --frozen-lockfile

FROM base AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/stator/node_modules ./packages/stator/node_modules
COPY --from=deps /app/apps/landing/node_modules ./apps/landing/node_modules
COPY . .

RUN pnpm --filter=landing build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["pnpm", "--filter=landing", "start"]
