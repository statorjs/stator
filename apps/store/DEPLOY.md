# Deploying Plimsoll

One always-on machine (SSE fan-out is in-process) + Upstash Redis for
sessions and persisted app state.

```sh
fly launch --no-deploy --copy-config          # from apps/store/
fly redis create                              # or bring an Upstash URL
fly secrets set REDIS_URL=redis://…
fly deploy --dockerfile apps/store/Dockerfile --build-context ../..  # or: fly deploy from repo root with config pointing here
```

Notes:
- The Docker build context is the REPO ROOT (workspace dep on the framework).
- Sessions slide a 2-hour TTL; shared stock/orders reset to seed every 24h
  ("the tide comes in" — see start.ts).
- `/admin` is off in production unless `STORE_ADMIN=1`.
