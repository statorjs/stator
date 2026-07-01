/**
 * The `.stator` language server — a standard Volar node server.
 *
 * Editor-agnostic: any LSP client launches this over stdio (the VSCode extension
 * is one client; nvim/emacs/helix/zed configure the same binary). It federates
 * the TypeScript and CSS language services over the virtual code produced by the
 * Stator language plugin.
 */

import {
  createConnection,
  createServer,
  createTypeScriptProject,
  loadTsdkByPath,
} from '@volar/language-server/node'
import { create as createTypeScriptServices } from 'volar-service-typescript'
import { create as createCssService } from 'volar-service-css'
import { statorLanguagePlugin } from './language-plugin.ts'

const connection = createConnection()
const server = createServer(connection)

connection.onInitialize((params) => {
  const options = params.initializationOptions as { typescript?: { tsdk?: string } } | undefined
  const tsdkPath = options?.typescript?.tsdk
  if (!tsdkPath) {
    throw new Error(
      'stator language server: initializationOptions.typescript.tsdk (path to the TS lib dir) is required.',
    )
  }
  const tsdk = loadTsdkByPath(tsdkPath, params.locale)
  return server.initialize(
    params,
    createTypeScriptProject(tsdk.typescript, tsdk.diagnosticMessages, () => ({
      languagePlugins: [statorLanguagePlugin],
    })),
    [...createTypeScriptServices(tsdk.typescript), createCssService()],
  )
})

connection.onInitialized(() => server.initialized())
connection.listen()
