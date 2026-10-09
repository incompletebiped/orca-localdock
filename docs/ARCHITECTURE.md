# Architecture

```
┌──────────── Orca ────────────┐
│ Right sidebar                │        ┌──────── plugin worker (Node) ────────┐
│ ┌──────────────────────────┐ │  gap 1 │ main.ts      commands, events        │
│ │ LocalDock panel (iframe) │◄├────────┤ controller.ts  state machine         │
│ │ render.ts · app.ts       │ │        │ orca/pluginHost.ts ── gaps 2–5 ──► Orca│
│ │ bridge.ts                │ │        │            │                         │
│ └──────────────────────────┘ │        │            ▼                         │
└──────────────────────────────┘        │  @localdock/core (engine)            │
                                        │   discovery · sync · db · ddev       │
                                        └──────┬────────────────┬──────────────┘
                                               │ RemoteShell/Fs │ ddev CLI
                                               ▼                ▼
                                        cPanel server     local DDEV project
                                        (via Orca SSH)    (the Orca project folder)
```

## Packages

### `packages/core`: the engine

This package has no Orca or VS Code dependencies.

- `discovery/`: as root, lists cPanel accounts with `whmapi1 listaccts`, then each account's domains with `uapi DomainInfo domains_data`. Detects WordPress from `wp-includes/version.php`. Domains that share a docroot collapse into one site.
- `sync/`: the sync baseline lives in `.localdock/state.json` and records each file's hash plus its remote and local stat at the last sync. `changeSet.ts` compares the baseline against the local and remote content and classifies each file as **push**, **pull**, **conflict** or **same**. Only files whose stat changed get hashed. Remote files are hashed with `sha1sum` over SSH.
  - Listing the server is one `find -printf` over SSH (NUL-separated path, size, mtime), not a walk of SFTP directories.
  - Downloads (a whole pull, or pulling selected server changes) are one `tar -cz` stream of exactly the listed files, unpacked as it arrives (`remoteArchive.ts`). Each file is hashed while it's written, so the baseline costs no extra server round trips. Speed depends on the bytes moved, not the number of files. Uploads still go file by file over SFTP, since they're only the files you changed.
- `operations/fileSync.ts`: push and pull of selected files. It recomputes the change set first, so a file that changed on the server since the user last looked becomes a conflict instead of being overwritten.
- `db/`:
  - `mysqldump` and `mysql` stream over SSH. Credentials go in a 0600 option file in the account's home directory, never on a command line.
  - Pushes are selective by table group, and each one takes a gzipped backup first, with automatic rollback.
  - URL search-replace keeps PHP serialized data intact (mysqli, `allowed_classes: false`).
- `ddev/`: `ddev config`, `start`, `stop`, `describe`, `import-db`, `wp search-replace`, plus the local-only `wp-config.php` and helper files.
- `ssh/`: the `RemoteShell` and `RemoteFs` interfaces the engine runs on. `SshConnection` is an ssh2 implementation with host-key pinning, for the case where Orca exposes connection details rather than sessions.

### `packages/orca-plugin`: the plugin

- `orca-plugin.json`: the manifest. It declares one panel, the commands and the capabilities.
- `src/worker/main.ts`: `activate(orca)`. It registers `localdock.state` and `localdock.dispatch` (the panel's two entry points) plus command-palette shortcuts.
- `src/worker/controller.ts`: the state machine:
  `no-project → no-hosts | choose-host → scanning → site-list → pulling → tracking`.
  In `tracking`, the panel looks like Source Control and has DDEV controls. Panel actions are validated with zod (`shared/actionSchema.ts`). A pull only accepts sites the worker discovered itself.
- `src/worker/orca/`: `OrcaHost` is the interface to everything Orca provides. `PluginOrcaHost` implements it with Orca's Host API v0 and throws `OrcaApiPendingError` for the gaps.
- `src/panel/`: the UI. `render.ts` is a pure function from state to HTML, and every string from the server is escaped. Confirmations happen inline, because the sandbox blocks `confirm()`. `bridge.ts` is the panel's side of the messaging (gap 1).
- `src/preview/`: a browser preview with sample states. It's not shipped.
- `scripts/build.mjs`: bundles the worker into `dist/worker.mjs`, and inlines the panel's script and CSS into `dist/panel/index.html`, because the panel's CSP allows inline only.

## Swap points

All Orca-specific gaps sit behind two seams. A fork that experiments with workarounds, or the real implementation once Orca ships the APIs, only touches these:

| Seam | File | What changes |
|---|---|---|
| Panel ↔ worker | `src/panel/bridge.ts` (`PanelBridge`) and `src/worker/transport.ts` (`PanelTransport`) | How the panel gets state and sends actions |
| Everything else from Orca | `src/worker/orca/host.ts` (`OrcaHost`) | Project path, SSH hosts, SSH sessions, opening URLs |

The engine, the controller and the UI stay the same.

## Local files in a pulled project

| File | Purpose | Synced? |
|---|---|---|
| `.localdock/state.json` | Sync baseline | No |
| `.localdock/db.sql` | Last database dump (**contains personal data**) | No |
| `.ddev/` | DDEV project config | No |
| `wp-config.php` | Local config: table prefix, local salts, loads `wp-config-ddev.php` | No (production keeps its own) |
| `wp-content/mu-plugins/localdock-dev.php` | Turns off cache plugins locally | No |
| `wp-content/uploads/.htaccess` | Serves missing media from the live site | No |
