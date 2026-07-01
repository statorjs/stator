import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node'

let client: LanguageClient | undefined

export async function activate(): Promise<void> {
  // Resolve our own server + TypeScript from node_modules — no dependency on the
  // proprietary built-in TS extension, so this works identically in VSCodium.
  const serverModule = require.resolve('@statorjs/language-server/server')
  const tsdk = path.dirname(require.resolve('typescript'))

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  }
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'stator' }],
    initializationOptions: { typescript: { tsdk } },
  }

  client = new LanguageClient('stator', 'Stator Language Server', serverOptions, clientOptions)
  await client.start()
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop()
}
