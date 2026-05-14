FROM node:22-slim AS base

# Enable Corepack for the pinned pnpm version declared in package.json.
RUN corepack enable

WORKDIR /app

# --- deps stage: install pnpm dependencies ---
# Copy only manifest files first so dep installs cache layer-by-layer.
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/stator/package.json ./packages/stator/
COPY apps/example/package.json ./apps/example/

# Workspace-aware install. CI=true silences pnpm's interactive prompts.
RUN CI=true pnpm install --frozen-lockfile

# --- runtime stage: copy source on top of deps ---
FROM base AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/stator/node_modules ./packages/stator/node_modules
COPY --from=deps /app/apps/example/node_modules ./apps/example/node_modules
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# `pnpm start` runs `tsx server.ts` inside apps/example. tsx handles TS
# transformation at startup — cost is paid once per machine boot, not per
# request. See deploy notes in README for the rationale.
CMD ["pnpm", "--filter=example", "start"]
