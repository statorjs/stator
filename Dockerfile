FROM node:22-slim AS base

# Enable Corepack for the pinned pnpm version declared in package.json.
RUN corepack enable

WORKDIR /app

# --- deps stage: install pnpm dependencies ---
# Copy only manifest files first so dep installs cache layer-by-layer.
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/stator/package.json ./packages/stator/
COPY apps/store/package.json ./apps/store/

# Workspace-aware install. CI=true silences pnpm's interactive prompts.
RUN CI=true pnpm install --frozen-lockfile

# --- runtime stage: copy source on top of deps ---
FROM base AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/stator/node_modules ./packages/stator/node_modules
COPY --from=deps /app/apps/store/node_modules ./apps/store/node_modules
COPY . .

# Bake the production build (compiled .stator routes + hashed island bundles
# + manifest) into the image; `start` serves dist/.
RUN pnpm --filter=store build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Plimsoll (apps/store) is the public demo. `start` runs `tsx start.ts` —
# raw-TS by design; the transform cost is paid once per machine boot.
CMD ["pnpm", "--filter=store", "start"]
