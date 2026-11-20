# What LocalDock needs from Orca

LocalDock uses Orca's plugin host API 1 (manifest format 2, Orca 1.4.248 or later) for everything Orca offers plugins. Where Orca has no plugin API yet (its SSH hosts, its browser), LocalDock uses the same thing a terminal would, as described below.

## What LocalDock uses today

| Need | Orca API |
|---|---|
| Panel ↔ worker messaging | The panel calls `orca.plugin.request('state' \| 'dispatch')`, and the worker answers with `orca.panels.handle`. The worker pushes every new state with `orca.panels.post('state', …)`, so the panel doesn't poll (it re-checks every 15 s in case a push was lost). States over 256 KiB go out as a `state.stale` notice and the panel fetches them with a request. |
| The open project's folder | `workspace.readContext` gives the focused `workspaceId`, and `workspace.list` gives its `path` and `hostId`. Projects on an SSH host or another Orca are left alone, since DDEV runs sites on this computer. The `workspace.changed` event refreshes the panel when you switch projects. |
| Opening the site, WP Admin, Mailpit, the live site | There's no plugin API for Orca's browser, so the worker runs Orca's own CLI launcher (`orca tab create --url … --worktree path:<project>`, spawned without a shell, found next to the Orca executable). The URL comes from the worker's state; the panel only names the button. If the CLI fails, the panel falls back to `orca.shell.openExternal` (default browser; Orca asks once per new web host). |
| Status | A status bar item (`statusBar.update`) shows the tracked site, its pending changes, or the running job. Clicking it checks the server for changes. Declaring a status bar item also keeps the worker running while the plugin is enabled, so the file watcher and in-memory state survive. |
| Servers | The user's SSH config, not Orca's SSH hosts (see below). |
| Storage, notifications | `storage.get`/`storage.set` (`storage:own`), `notifications.show`. |

## What Orca doesn't offer yet, and what LocalDock does instead

### Orca's SSH hosts and connections

- **Would like:** list the SSH hosts configured in Orca (Settings → SSH) and run commands and transfer files over Orca's connection to one, with Orca handling keys, passphrases and host-key prompts as it does for remote projects. LocalDock's engine only needs the small `RemoteShell` and `RemoteFs` interfaces in `packages/core/src/ssh/types.ts`.
- **Today:** plugins can see that a project lives on an SSH host (`hostId: "ssh:<id>"` in `workspace.list`), but can't list Orca's hosts' details or use its connections.
- **What LocalDock does instead:** it uses the hosts in the user's SSH config, like the ork-db plugin. `ssh -G <alias>` resolves each one exactly as `ssh` would, `ssh-keygen -F` checks the server's key against `known_hosts`, and LocalDock opens one connection of its own (`packages/core/src/ssh/sshConfig.ts`, `SshConnection.ts`) with the user's identity files and agent. Spawning `ssh` per command would also work, but each spawn is a full SSH login (several seconds on a distant server), and a sync runs many commands. Sites saved with an Orca SSH host id (by an earlier, since-retired build that used Orca's hosts) are found through `orca host list` when an SSH config alias has the same name.
- **Limits:** hosts added only in Orca's settings (not in the SSH config) don't show up; jump hosts (`ProxyJump`, `ProxyCommand`) aren't supported; passphrase-protected keys need the agent.
- **In the code:** `PluginOrcaHost.listSshHosts()`, `findSshHost()` and `openSession()` in `packages/orca-plugin/src/worker/orca/pluginHost.ts`. If Orca adds an SSH API, only these change.

## Also on the wishlist

- **A host API for Orca's browser** (open a tab in a workspace), to replace the CLI call LocalDock uses for links.
- **An "Add Project" source**, so "WordPress site from an SSH host" can appear in Orca's Add Project dialog, and the empty-project step goes away ([#12531](https://github.com/stablyai/orca/issues/12531)).
- **A source-control provider API**, so LocalDock's changes could appear in Orca's own Source Control UI ([#5930](https://github.com/stablyai/orca/issues/5930)).

## Closed gaps

- **Panel ↔ worker messaging:** shipped as `plugin.request` / `orca.panels.handle` / `orca.panels.post` ([#37013](https://github.com/stablyai/orca/pull/37013), which closed [#15638](https://github.com/stablyai/orca/issues/15638) and superseded [PR #25256](https://github.com/stablyai/orca/pull/25256)).
- **The open project's folder:** `workspace.readContext` now carries `workspaceId`, and `workspace.list` (host API 1.3) gives each workspace's path.
- **Open a URL:** `shell.openExternal` (host API 1.1), in the default browser.
