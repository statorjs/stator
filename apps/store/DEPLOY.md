# Deploying Plimsoll

Plimsoll IS the public demo at demo.statorjs.dev — the repo-root
`Dockerfile` + `fly.toml` deploy it to the existing `statorjs-demo` Fly app
(one always-on machine: SSE fan-out is in-process; Upstash Redis via the
`REDIS_URL` secret).

```sh
fly deploy            # from the repo root
```

Notes:
- The image bakes `pnpm --filter=store build` (dist/ + island bundles).
- Sessions slide a 2-hour TTL; shared stock/orders reset to seed every 24h
  ("the tide comes in" — see start.ts).
- `/admin` is off in production unless `STORE_ADMIN=1` is set on the app.
