# Architecture

```
┌──────────── Orca ────────────┐
│ Right sidebar                │        ┌──────── plugin worker (Node) ────────┐
│ ┌──────────────────────────┐ │request │ main.ts   handlers, commands, events │
│ │ LocalDock panel (iframe) │◄├───────►┤ controller.ts  state machine         │
│ │ render.ts · app.ts       │ │  post  │ orca/pluginHost.ts ── host API ──► Orca│
│ │ bridge.ts                │ │        │            │   SSH: your ssh config  │
│ └──────────────────────────┘ │        │            ▼                         │
│ Status bar: site ↑3 ↓1       │        │  @localdock/core (engine)            │
└──────────────────────────────┘        │   discovery · sync · db · ddev       │
                                        └──────┬────────────────┬──────────────┘
                                               │ RemoteShell/Fs │ ddev CLI
                                               ▼                ▼
                                        cPanel server     local DDEV project
                                        (via SSH)         (the Orca project folder)
```

## Packages

### `packages/core`: the engine

This package has no Orca or VS Code dependencies.

- `discovery/`: as root, lists cPanel accounts with `whmapi1 listaccts`, then each account's domains with `uapi DomainInfo domains_data`. Detects WordPress from `wp-includes/version.php`. Domains that share a docroot collapse into one site.
- `sync/`: the sync baseline lives in `.localdock/state.json` and records each file's hash plus its remote and local stat at the last sync. `changeSet.ts` compares the baseline against the local and remote content and classifies each file as **push**, **pull**, **conflict** or **same**. Only files whose stat changed get hashed. Remote files are hashed with `sha1sum` over SSH.
  - Listing the server is one `find -printf` over SSH (NUL-separated path, size, mtime), not a walk of SFTP directories.
  - Downloads (a whole pull, or pulling selected server changes) are `tar -cz` streams of exactly the listed files, unpacked as they arrive (`remoteArchive.ts`). Each file is hashed while it's written, so the baseline costs no extra server round trips. Speed depends on the bytes moved, not the number of files. Anything over 1 MB is split into four archives of about equal size, sent side by side on the one connection: over a distant link each SSH channel is held back by the round trip. Uploads still go file by file over SFTP, since they're only the files you changed.
  - A pull saves the files it has finished to `.localdock/pull.json` every few seconds (`pullProgress.ts`). Resuming re-lists the server and keeps each recorded file whose server size and mtime and local size and mtime are unchanged; the rest, and the database, are downloaded again. The record goes once `state.json` is written.
- `operations/fileSync.ts`: push and pull of selected files. It recomputes the change set first, so a file that changed on the server since the user last looked becomes a conflict instead of being overwritten.
- `db/`:
  - `mysqldump` and `mysql` stream over SSH. Credentials go in a 0600 option file in the account's home directory, never on a command line.
  - Pushes are selective by table group, and each one takes a gzipped backup first, with automatic rollback.
  - URL search-replace keeps PHP serialized data intact (mysqli, `allowed_classes: false`).
- `ddev/`: `ddev config`, `start`, `stop`, `describe`, `import-db`, `wp search-replace`, plus the local-only `wp-config.php` and helper files.
  - The PHP version comes from the site's cPanel `.htaccess` handler (`ea-php83` → 8.3), falling back to the server's CLI `php`.
  - Media (`wp-content/uploads`) isn't pulled, except for the CSS that themes and page builders generate there. Missing media is redirected to the live site.
  - On Windows, the project's drive is mounted inside Docker Desktop's WSL distro before each start, so projects on removable drives work.
  - Docker housekeeping: stopping the last site runs `ddev poweroff`, Docker Desktop can be started and quit from the panel, and "Free up space" removes only DDEV images tagged for another DDEV version.
- `ssh/`: the `RemoteShell` and `RemoteFs` interfaces the engine runs on. `SshConnection` is the ssh2 implementation: one connection per host, trusting either the user's `known_hosts` keys or a pinned key. When the connection drops, every command and SFTP call still waiting on it fails with `SSH_TIMEOUT` (ssh2 alone would leave SFTP calls waiting forever), and the controller reconnects for the next step. `sshConfig.ts` lists the aliases in `~/.ssh/config`, resolves one with `ssh -G`, looks its key up with `ssh-keygen -F`, and connects with the user's identity files, then the agent.

### `packages/orca-plugin`: the plugin

- `orca-plugin.json` (at the repository root, which is the plugin folder): the manifest (format 2, `trusted-worker`). It declares one panel, the palette commands, the `workspace.changed` event, a status bar item, the capabilities, and the icon, cover and screenshots in `docs/media/`. It names the built worker and panel in `plugin/`, which are committed because installs from Git run no build; CI fails when they don't match the source.
- `src/worker/main.ts`: `activate(orca)`. It answers the panel's two requests (`state` and `dispatch`) with `orca.panels.handle`, registers the command-palette shortcuts, refreshes on `workspace.changed`, and keeps the status bar item current. A dispatch answers within 400 ms with the state so far, because a pull can outlast a panel request; the rest arrives as pushes.
- `src/worker/transport.ts`: pushes each state to the panel with `orca.panels.post`, at most every 100 ms (Orca allows 200 posts per 10 s). A state over 256 KiB goes out as a `state.stale` notice, and the panel fetches it.
- `src/worker/status.ts`: the status bar text for a state.
- `src/worker/controller.ts`: the state machine:
  `no-project | project-not-empty | set-up → no-hosts | choose-host → scanning → site-list → pulling → tracking`. An empty project stays at `set-up` until the user opts in. A pull that stops part-way leads to `pull-interrupted`, which offers Resume (from the host, account and docroot recorded in plugin storage when the pull started, never from the project folder) or Start over.
  In `tracking`, the panel looks like Source Control and has DDEV controls. Panel actions are validated with zod (`shared/actionSchema.ts`). A pull only accepts sites the worker discovered itself.
- `src/worker/orca/`: `OrcaHost` is the interface to everything Orca provides. `PluginOrcaHost` implements it with Orca's host API 1, and SSH with the user's SSH config (Orca doesn't share its SSH hosts with plugins).
- `src/panel/`: the UI. `render.ts` is a pure function from state to HTML, and every string from the server is escaped. Confirmations happen inline, because the sandbox blocks `confirm()`. `bridge.ts` is the panel's side of the messaging (`window.orca.plugin`). Link buttons and the local URL ask the worker (`open` request) to open a tab in Orca's browser through Orca's CLI; if that fails, the panel opens the default browser with `orca.shell.openExternal`, which Orca only allows from a click in the frame. Colors come from Orca's `--orca-*` frame variables.
- `src/preview/`: a browser preview with sample states. It's not shipped.
- `scripts/build.mjs`: bundles the worker into `plugin/worker.mjs` (not minified, so the shipped code can be read), and inlines the panel's script and CSS into `plugin/panel/index.html`, so it also works in browser clients of `orca serve`, whose frames allow inline only.

## Swap points

Everything Orca-specific sits behind two seams. A fork that connects differently (for example to Orca's own SSH hosts), or a future version using an Orca SSH API, only touches these:

| Seam | File | What changes |
|---|---|---|
| Panel ↔ worker | `src/panel/bridge.ts` (`PanelBridge`) and `src/worker/transport.ts` (`PanelTransport`) | How the panel gets state and sends actions |
| Everything else from Orca | `src/worker/orca/host.ts` (`OrcaHost`) | Project path, SSH hosts, SSH sessions, status bar |

The engine, the controller and the UI stay the same.

## Local files in a pulled project

| File | Purpose | Synced? |
|---|---|---|
| `.localdock/state.json` | Sync baseline | No |
| `.localdock/server.json` | The server's changes since the baseline, from the last check | No |
| `.localdock/pull.json` | Files an unfinished pull has finished (gone once the pull completes) | No |
| `.localdock/db.sql` | Last database dump (**contains personal data**) | No |
| `.ddev/` | DDEV project config | No |
| `wp-config.php` | Local config: table prefix, local salts, loads `wp-config-ddev.php` | No (production keeps its own) |
| `wp-content/mu-plugins/localdock-dev.php` | Turns off cache plugins locally, hides PHP notices on web pages, and sends missing media to the live site | No |
| `wp-content/uploads/.htaccess` | Serves missing media from the live site | No |
