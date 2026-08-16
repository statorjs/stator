import { dangerouslyDefineMiddleware } from '../../src/server/middleware.ts'

// No framework defaults, no handlers — the app owns (and here, forgoes) security.
export default dangerouslyDefineMiddleware([])
