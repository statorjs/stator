---
title: 'Neovim setup'
description: 'Wire the Stator language server into Neovim — completions, hover, and diagnostics in .stator files, without the VS Code extension.'
sidebar:
  order: 12
---

The [VS Code extension](/guides/editor-setup/) is self-contained: it bundles the language server and a copy of TypeScript, so installing it is the whole setup. Neovim has no such bundle. You point an LSP client at the same `stator-language-server` binary and supply the two things the extension was quietly providing for you.

Those two things are both hard failures, and neither produces an obvious error message, so they are worth stating up front:

- **`--stdio`.** The server needs an explicit transport flag. Launch it without one and it exits immediately with `Connection input stream is not set`.
- **`initializationOptions.typescript.tsdk`.** A path to a directory containing `typescript.js`. The server refuses to initialize without it, and the failure surfaces as an LSP `-32603` error rather than anything about TypeScript.

Everything below is for Neovim 0.11 or newer, which is when `vim.lsp.config()` and `vim.lsp.enable()` arrived. No plugin manager is required.

## Install the server

```sh
npm install -g @statorjs/language-server
```

`typescript` is a peer dependency and a global install does **not** pull it in. The config below prefers your project's own TypeScript — which is what you want, so templates type-check against the version the project builds with — and falls back to a global copy. If your projects always have TypeScript installed locally, you need nothing else. Otherwise:

```sh
npm install -g typescript
```

## Configure

Neovim has no built-in filetype for `.stator`, so register it first. Drop this in `~/.config/nvim/lua/stator.lua` and `require("stator")` from your `init.lua`:

```lua
vim.filetype.add({ extension = { stator = "stator" } })

-- Prefer the project's own TypeScript; walk upward so a pnpm/monorepo layout
-- with TypeScript hoisted to the root still resolves. Fall back to a global install.
local function resolve_tsdk(start)
  local roots = vim.fs.find("node_modules", {
    path = start, upward = true, type = "directory", limit = math.huge,
  })
  for _, node_modules in ipairs(roots) do
    local candidate = vim.fs.joinpath(node_modules, "typescript", "lib")
    if vim.uv.fs_stat(vim.fs.joinpath(candidate, "typescript.js")) then
      return candidate
    end
  end
  local ok, out = pcall(vim.fn.system, { "npm", "root", "-g" })
  if ok and vim.v.shell_error == 0 then
    local candidate = vim.fs.joinpath(vim.trim(out), "typescript", "lib")
    if vim.uv.fs_stat(vim.fs.joinpath(candidate, "typescript.js")) then
      return candidate
    end
  end
end

vim.lsp.config("stator", {
  cmd = function(dispatchers, config)
    local bin = "stator-language-server"
    if config and config.root_dir then
      local local_bin = vim.fs.joinpath(config.root_dir, "node_modules", ".bin", bin)
      if vim.fn.executable(local_bin) == 1 then
        bin = local_bin
      end
    end
    return vim.lsp.rpc.start({ bin, "--stdio" }, dispatchers)
  end,
  filetypes = { "stator" },
  root_markers = { "tsconfig.json", "package.json", ".git" },
  before_init = function(params, config)
    local tsdk = resolve_tsdk(config.root_dir or vim.fn.getcwd())
    if not tsdk then
      vim.notify("stator-ls: no TypeScript found", vim.log.levels.WARN)
    end
    config.init_options = vim.tbl_deep_extend(
      "force", config.init_options or {}, { typescript = { tsdk = tsdk } }
    )
    params.initializationOptions = config.init_options
  end,
})

vim.lsp.enable("stator")
```

Resolving the binary from `node_modules/.bin` first means a project can pin the server as a devDependency and everyone on the team gets the same version.

### LazyVim

LazyVim configures servers through `nvim-lspconfig`'s `opts.servers`. Keep `vim.filetype.add` and `resolve_tsdk` as above, then return a spec instead of calling `vim.lsp.config` directly — LazyVim calls it for you:

```lua
return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        stator = {
          cmd = function(dispatchers, config) --[[ as above ]] end,
          filetypes = { "stator" },
          root_markers = { "tsconfig.json", "package.json", ".git" },
          before_init = function(params, config) --[[ as above ]] end,
        },
      },
    },
  },
}
```

Because `stator` is not in Mason's registry, LazyVim skips its Mason path and enables the server directly — no `ensure_installed` entry, and no error about a missing package.

## Confirm it works

Open any `.stator` file and run `:checkhealth vim.lsp`. You want the `stator` client listed as attached, with a root directory matching your project. `:lua =vim.lsp.get_clients({ bufnr = 0 })[1].config.init_options` shows the tsdk that was resolved — the single most useful thing to check when the server starts but nothing works.

A quick end-to-end test: put `const n: number = 1` and `n.toUpperCase()` in a `<script>` block. You should get `Property 'toUpperCase' does not exist on type 'number'` on the right line. Add `colr: red` to a `<style>` block and the CSS service should flag the typo. Both services run over the same file, mapped back through the compiler's virtual code.

## Syntax highlighting

There is no tree-sitter grammar for `.stator`, so Neovim has nothing to highlight the markup with — the TextMate grammar in `editors/vscode/syntaxes/` only works in TextMate-compatible editors.

What you do get is LSP semantic tokens, which Neovim applies automatically. That covers identifiers inside the frontmatter, `<script>`, and `<style>` regions. Tags and template interpolation stay unhighlighted. If that bothers you, a tree-sitter grammar is the fix, and it would benefit Helix and Zed at the same time.

## What to watch for

- **Diagnostics that look wrong are usually missing types.** A project needs `stator-env.d.ts` and a `sync` run for imports and prop types to resolve — see [editor setup](/guides/editor-setup/). Without them you will see `JSX.IntrinsicElements` errors on ordinary tags. Run your install and `sync` before concluding the server is broken.
- **`root_markers` decides which TypeScript gets used.** In a monorepo the root resolves to the nearest `package.json`, so a per-app TypeScript wins over the workspace root. That is usually what you want; it is also why two apps in one repo can behave differently.
- **The server is not in Mason.** Install it with `npm` as above. `:MasonInstall` will not find it.
- **Testing a local build?** Point `cmd` at `packages/language-server/bin/stator-language-server.js` (run `pnpm --filter @statorjs/language-server build` first — the bin loads `dist/`, which is not checked in). Useful when changing the server itself.
- **Restart Neovim after changing the config.** Editing `cmd`, `root_markers`, or the tsdk logic affects clients as they start, so the reliable way to pick up a change is to quit and reopen. (`:LspRestart` comes from `nvim-lspconfig`, not core, and is not available in the plugin-free setup above.)
