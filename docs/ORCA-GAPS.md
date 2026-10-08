# What LocalDock needs from Orca

LocalDock is built as far as **Orca 1.4.222**'s plugin API allows. These are the capabilities it still needs. Each one is a single method that throws `OrcaApiPendingError` today. When Orca ships the capability, that method gets implemented and the gap is removed from this list.

The Orca team has said plugin-system improvements are on the way ([discussion #6332](https://github.com/stablyai/orca/discussions/6332#discussioncomment-18561300)).

## What Orca plugins can do today

- **Panels:** a sandboxed iframe in the right sidebar. The CSP is `connect-src 'none'`, and only inline script and CSS are allowed. A panel can call exactly three host actions: `workspace.readContext`, `terminal.sendText` and `notifications.show`.
- **Workers:** a plain Node process. It can register commands, receive three events (`worktree.created`, `worktree.removed`, `agent.status.changed`), and call the host API: storage, secrets, settings and notifications.

LocalDock's worker can already run DDEV and do all of its own sync work. What's missing is a way to reach Orca's projects, SSH hosts and the panel.

## Gaps

### 1. `panel-bridge`: panel ↔ worker messaging (**blocking**)

- **Need:** the panel must call its own worker's commands (`localdock.state` and `localdock.dispatch`) and get the result back. A push channel from worker to panel would be nicer than polling, but polling is enough.
- **Today:** neither direction exists. The panel can only use the three host actions above.
- **In the code:**
  - `packages/orca-plugin/src/panel/bridge.ts`: `OrcaPanelBridge` sends a `commands.invoke` panel action, which Orca rejects today. The panel then shows "Waiting on Orca".
  - `packages/orca-plugin/src/worker/transport.ts`: the worker keeps the latest state snapshot for the panel to fetch.
- **Upstream:** [#15638](https://github.com/stablyai/orca/issues/15638), [#25129](https://github.com/stablyai/orca/issues/25129), [PR #25256](https://github.com/stablyai/orca/pull/25256). PR #25256's `commands.invoke` is exactly the shape the bridge uses.

### 2. `project-path`: the active project's folder (**blocking**)

- **Need:** the absolute path of the project open in Orca, so LocalDock can pull a site into it and track its changes.
- **Today:** `workspace.readContext` returns only `{ branch, displayName, terminals }`. The `worktree.created` event does carry a `path`, but only for worktrees created while the plugin is running.
- **In the code:** `PluginOrcaHost.activeProject()` in `packages/orca-plugin/src/worker/orca/pluginHost.ts`.
- **Ask:** add `path` (and ideally `repoId`/`worktreeId`) to `workspace.readContext`.

### 3. `ssh-hosts`: Orca's SSH hosts (**blocking**)

- **Need:** list the SSH hosts configured in Orca (id, label, user, host, port) and whether each is connected, and ask Orca to connect one. Orca would handle keys, passphrases and host-key prompts the same way it does for remote projects.
- **Today:** plugins have no access to SSH hosts.
- **In the code:** `PluginOrcaHost.listSshHosts()` and `connectSshHost()`.

### 4. `ssh-session`: commands and file transfer over Orca SSH (**blocking**)

- **Need:** run a command on a host (with stdin/stdout streaming and an exit code), and list, read, write, stat and delete files over an Orca SSH connection. LocalDock's engine only needs the small `RemoteShell` and `RemoteFs` interfaces in `packages/core/src/ssh/types.ts`.
- **Today:** not available to plugins. Orca's SSH relay already does all of this for remote projects.
- **In the code:** `PluginOrcaHost.openSession()`.
- **Alternative:** if Orca exposes a host's connection details (host, user, identity file) instead, the worker could open its own SSH connection. `packages/core/src/ssh/SshConnection.ts` already implements that, with host-key pinning.
- **Upstream:** related to [PR #21783](https://github.com/stablyai/orca/pull/21783) (remote runtime panels).

### 5. `open-url`: open a URL in Orca's browser (nice to have)

- **Need:** open the local site, WP Admin and Mailpit in an Orca browser tab.
- **In the code:** `PluginOrcaHost.openUrl()`.

## Also on the wishlist

- **An "Add Project" source**, so "WordPress site from an SSH host" can appear in Orca's Add Project dialog, and the empty-project step goes away ([#12531](https://github.com/stablyai/orca/issues/12531)).
- **A source-control provider API**, so LocalDock's changes could appear in Orca's own Source Control UI ([#5930](https://github.com/stablyai/orca/issues/5930)).
