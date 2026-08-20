// A stray user vite.config that MUST be ignored by `createDevApp` (it sets
// `configFile: false`, matching the production build). If the dev server ever
// starts reading a user config again, evaluating this file throws and the
// dev-server boot in `dev-server.test.ts` fails loudly — the regression guard
// for the dev/prod parity fix.
throw new Error('STRAY_VITE_CONFIG_WAS_READ — createDevApp must set configFile: false')
