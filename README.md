# LocalDock for Orca

> **🚧 Work in progress: this plugin does not work yet.**
> It is built as far as Orca's plugin API allows today. The remaining pieces depend on capabilities Orca plugins don't have yet (listed below), so for now this repo is the foundation, ready for when they arrive.

**Local WP, but for cPanel, inside [Orca](https://github.com/stablyai/orca).** LocalDock is an Orca plugin that adds a **LocalDock** tab to the right sidebar, next to Source Control:

1. **Create a new, empty project** in Orca, open the LocalDock tab, and click **Use LocalDock in this project**. LocalDock leaves projects you don’t set up alone.
2. **Connect to a server.** LocalDock uses the SSH hosts you've already added in Orca (Settings → SSH). Add one that points at a cPanel server: log in as `root` to see every account on a WHM server, or as a cPanel account user to see that account's sites. If no host is connected, the tab tells you what to do.
3. **Pick a WordPress site.** LocalDock scans the server (via cPanel's own `whmapi1`/`uapi`) and lists every WordPress install it finds.
4. **Pull it.** The site's files and database come down into the project, and **[DDEV](https://ddev.com)** runs it locally, with the same PHP and database versions as the server.
5. **Work like Source Control.** Once a site is pulled, the tab stops listing server sites and becomes a sync view for this project:
   - **Local changes** you can push (edits by you or an AI agent in Orca).
   - **Server changes** you can pull (plugin updates, edits made in WP Admin).
   - **Changed on both sides**: flagged, never silently overwritten.
   - **Start / Stop** the local site, and open it, WP Admin or Mailpit.
   - **Database:** pull the live database, or push selected table groups (content, settings, …) with an automatic server-side backup and rollback.

Nothing is installed on your server, and no server details are stored by LocalDock: connections are Orca's.

## Status

| Part | State |
|---|---|
| Sync engine (`packages/core`): cPanel discovery, three-way change detection, file push/pull, database pull/push with backups, DDEV control | ✅ Built and unit-tested |
| Sidebar panel UI (`packages/orca-plugin/src/panel`): every screen from "connect a server" to the source-control view | ✅ Built; viewable in a browser preview with sample data |
| Plugin worker (`packages/orca-plugin/src/worker`): state machine wiring the panel to the engine | ✅ Built and unit-tested |
| **Panel ↔ worker messaging** | ⏳ Waiting on Orca |
| **The open project's folder path** | ⏳ Waiting on Orca |
| **Orca SSH hosts: list, connect, run commands, transfer files** | ⏳ Waiting on Orca |
| Open URLs in Orca's browser | ⏳ Waiting on Orca (nice to have) |

Each ⏳ item is a single, clearly marked method in the code that throws "waiting on Orca" today. See **[docs/ORCA-GAPS.md](docs/ORCA-GAPS.md)** for exactly what's needed and where it's tracked upstream. The Orca team has said plugin-system improvements are coming ([discussion #6332](https://github.com/stablyai/orca/discussions/6332#discussioncomment-18561300)).

## Try the panel

The panel can be previewed in a normal browser with sample data:

```sh
npm install
npm run preview      # builds packages/orca-plugin/preview/index.html
```

Open `packages/orca-plugin/preview/index.html` and switch between states with the menu at the top.

## Load it in Orca (for development)

```sh
npm run build        # builds packages/orca-plugin/dist
```

In Orca, open **Settings → Plugin Development** and add the `packages/orca-plugin/dist` folder. The LocalDock tab appears in the right sidebar and shows **"Waiting on Orca"**, listing the capability it's blocked on. That's expected until the gaps are filled.

## Clear a pulled site out of a project

To start over after a cancelled, failed or finished pull:

```sh
npm run reset-project -- <project folder>         # shows what would be deleted
npm run reset-project -- <project folder> --yes   # deletes it
```

It deletes the site's DDEV project (containers and database) and every file except `.git` and the other files a new project starts with. It refuses folders without a `.localdock` folder.

## Requirements (once it works)

- [Orca](https://github.com/stablyai/orca) 1.4.222 or later, with plugins enabled
- [DDEV](https://ddev.com/get-started/) (and the Docker provider it uses)
- An Orca SSH host pointing at a cPanel server (root or a cPanel account user)

## Repository layout

```
packages/core/          sync engine, independent of Orca (TypeScript, tested)
packages/orca-plugin/   the Orca plugin: manifest, worker, sidebar panel, preview
docs/ORCA-GAPS.md       what Orca needs to add, and where each gap lives in the code
docs/ARCHITECTURE.md    how the pieces fit together
```

## Security & privacy

LocalDock acts with your SSH access to production servers. See [SECURITY.md](SECURITY.md) for what it does on a server and how risks are handled. In short:

- It never downloads production's `wp-config.php` (credentials and salts stay on the server). Database passwords are read on demand and never stored.
- Panel input is validated and every server-supplied string is escaped.
- Pushes re-check the server first, and database pushes take a backup.
- No telemetry.

## Lineage

A rewrite of [cursor-extension-localdock](https://github.com/incompletebiped/cursor-extension-localdock), a VS Code/Cursor extension with the same goal.

## License

[MIT](LICENSE)
