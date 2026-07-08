# Plimsoll — built from the MONOREPO ROOT so the workspace dep resolves:
#   docker build -f apps/store/Dockerfile -t plimsoll .
# Raw-TS by design: no framework build step; tsx runs the source.
FROM node:24-slim
WORKDIR /repo

RUN corepack enable pnpm

# Workspace manifests first for layer caching.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/stator/package.json packages/stator/package.json
COPY apps/store/package.json apps/store/package.json
RUN pnpm install --frozen-lockfile --filter store... --ignore-scripts

COPY packages/stator packages/stator
COPY apps/store apps/store

WORKDIR /repo/apps/store
RUN pnpm build

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "start"]
