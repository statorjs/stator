# create-stator

Scaffold a new [Stator](https://statorjs.dev) app.

```sh
pnpm create stator my-app
```

It asks which template to start from, fetches it, names the app after the directory, and offers to install dependencies and start a git repository. Stator needs Node 24 or newer.

## Templates

| Template | What it is |
| --- | --- |
| `minimal` | One machine, one page: the smallest real app |
| `todomvc` | TodoMVC with server-owned todos and editing that needs no client JavaScript |
| `desksmith` | The tutorial's finished app: catalog, cart, checkout, a theme island |
| `live-poll` | Shared state pushed to every visitor over SSE |
| `with-auth` | Accounts, guarded login, roles, session rotation |
| `weather` | Live forecasts over SSE, a shared cache filled by effects, a canvas island |
| `registration` | The forms pattern: two-tier validation, a live roster, pre-filled editing |

## Options

Every prompt has a flag, so scripts and CI need no terminal:

```sh
pnpm create stator my-app --template todomvc --install --git
pnpm create stator my-app -t github:you/your-template
```

| Flag | Meaning |
| --- | --- |
| `-t, --template <name\|source>` | A template above, or any [giget](https://github.com/unjs/giget) source |
| `--ref <branch\|tag>` | Fetch a first-party template from a specific ref |
| `--install`, `--no-install` | Install dependencies, or don't |
| `--git`, `--no-git` | Start a git repository, or don't |
| `-y, --yes` | Accept every default |

A scaffolded app records where it came from under `stator.template` in its `package.json`, which is what lets you [pull in later changes to the template](https://docs.statorjs.dev/recipes/updating-from-a-template/).
