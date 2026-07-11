import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { type ExtensionContext, workspace } from 'vscode'
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node'

let client: LanguageClient | undefined

/**
 * The tsdk (directory containing typescript.js + lib .d.ts files) for the
 * language server. Prefer the WORKSPACE's own TypeScript — templates should
 * type-check against the version the project builds with — and fall back to
 * the copy bundled in the vsix, so the extension works in a bare editor.
 * No dependency on the proprietary built-in TS extension: identical
 * behavior in VS Code and VSCodium.
 */
function resolveTsdk(context: ExtensionContext): string {
  for (const folder of workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, 'node_modules', 'typescript', 'lib')
    if (existsSync(path.join(candidate, 'typescript.js'))) return candidate
  }
  return context.asAbsolutePath(path.join('dist', 'typescript', 'lib'))
}

export async function activate(context: ExtensionContext): Promise<void> {
  // The server is BUNDLED into the vsix (dist/server.cjs) — a packaged
  // extension has no node_modules to resolve from.
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.cjs'))

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc },
  }
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: 'stator' }],
    initializationOptions: { typescript: { tsdk: resolveTsdk(context) } },
  }

  client = new LanguageClient('stator', 'Stator Language Server', serverOptions, clientOptions)
  await client.start()
}

export function deactivate(): Promise<void> | undefined {
  return client?.stop()
}
