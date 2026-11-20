# What LocalDock needs from Orca

LocalDock uses Orca's plugin host API 1 (manifest format 2, Orca 1.4.248 or later). Everything except the server connection works through supported APIs. The capabilities it still needs are below. Each one is a single method that throws `OrcaApiPendingError` today. When Orca ships the capability, that method gets implemented and the gap is removed from this list.

## What LocalDock uses today

| Need | Orca API |
|---|---|
| Panel ↔ worker messaging | The panel calls `orca.plugin.request('state' \| 'dispatch')`, and the worker answers with `orca.panels.handle`. The worker pushes every new state with `orca.panels.post('state', …)`, so the panel doesn't poll (it re-checks every 15 s in case a push was lost). States over 256 KiB go out as a `state.stale` notice and the panel fetches them with a request. |
| The open project's folder | `workspace.readContext` gives the focused `workspaceId`, and `workspace.list` gives its `path` and `hostId`. Projects on an SSH host or another Orca are left alone, since DDEV runs sites on this computer. The `workspace.changed` event refreshes the panel when you switch projects. |
| Opening the site, WP Admin, Mailpit, the live site | There's no plugin API for Orca's browser, so the worker runs Orca's own CLI launcher (`orca tab create --url … --worktree path:<project>`, spawned without a shell, found next to the Orca executable). The URL comes from the worker's state; the panel only names the button. If the CLI fails, the panel falls back to `orca.shell.openExternal` (default browser; Orca asks once per new web host). |
| Status | A status bar item (`statusBar.update`) shows the tracked site, its pending changes, or the running job. Clicking it checks the server for changes. Declaring a status bar item also keeps the worker running while the plugin is enabled, so the file watcher and in-memory state survive. |
| Storage, notifications | `storage.get`/`storage.set` (`storage:own`), `notifications.show`. |

## Gaps

### 1. `ssh-hosts`: Orca's SSH hosts (**blocking**)

- **Need:** list the SSH hosts configured in Orca (id, label, user, host, port) and whether each is connected, and ask Orca to connect one. Orca would handle keys, passphrases and host-key prompts the same way it does for remote projects.
- **Today:** plugins can see that a project lives on an SSH host (`hostId: "ssh:<id>"` in `workspace.list` and `project.list`), but can't list the hosts or connect one. The `orca host list --json` command lists them with whether each is connected, but not their connection details.
- **In the code:** `PluginOrcaHost.listSshHosts()` and `connectSshHost()` in `packages/orca-plugin/src/worker/orca/pluginHost.ts`.

### 2. `ssh-session`: commands and file transfer over Orca SSH (**blocking**)

- **Need:** run a command on a host (with stdin/stdout streaming and an exit code), and list, read, write, stat and delete files over an Orca SSH connection. LocalDock's engine only needs the small `RemoteShell` and `RemoteFs` interfaces in `packages/core/src/ssh/types.ts`.
- **Today:** not available to plugins. Orca's SSH relay already does all of this for remote projects.
- **In the code:** `PluginOrcaHost.openSession()`.
- **Alternative:** a plugin worker runs as the user, with `SSH_AUTH_SOCK` passed through, so it could open its own SSH connection if it knew a host's details (host, user, identity file). `packages/core/src/ssh/SshConnection.ts` already implements that, with host-key pinning.

## Also on the wishlist

- **A host API for Orca's browser** (open a tab in a workspace), to replace the CLI call LocalDock uses for links.
- **An "Add Project" source**, so "WordPress site from an SSH host" can appear in Orca's Add Project dialog, and the empty-project step goes away ([#12531](https://github.com/stablyai/orca/issues/12531)).
- **A source-control provider API**, so LocalDock's changes could appear in Orca's own Source Control UI ([#5930](https://github.com/stablyai/orca/issues/5930)).

## Closed gaps

- **Panel ↔ worker messaging:** shipped as `plugin.request` / `orca.panels.handle` / `orca.panels.post` ([#37013](https://github.com/stablyai/orca/pull/37013), which closed [#15638](https://github.com/stablyai/orca/issues/15638) and superseded [PR #25256](https://github.com/stablyai/orca/pull/25256)).
- **The open project's folder:** `workspace.readContext` now carries `workspaceId`, and `workspace.list` (host API 1.3) gives each workspace's path.
- **Open a URL:** `shell.openExternal` (host API 1.1), in the default browser.
