# Roadmap

## Done

- [x] Sync engine: cPanel discovery, three-way change detection, file push/pull with conflict checks
- [x] Database: streamed pull, selective table-group push, server-side backup and rollback, serialization-safe URL rewrite
- [x] DDEV integration: config matched to the server's PHP and database versions, start/stop/describe, import, `wp search-replace`, live start progress
- [x] Sidebar panel UI for every step, plus a browser preview
- [x] Source-Control-style tracking: local changes watched live, server changes kept from the last check, per-file push/pull progress
- [x] Missing media served from the live site, so uploads don't need to be pulled
- [x] Docker housekeeping: start/quit Docker Desktop, `ddev poweroff` after the last site stops, free space from old DDEV images
- [x] Manifest format 2 and Orca's host API 1: panel ↔ worker messaging with pushes, the focused project's folder, links in Orca's browser, a status bar item
- [x] Servers over SSH through the user's SSH config (`ssh -G`, keys and agent, `known_hosts`)
- [x] End-to-end use on a real cPanel server: check for changes, pull the database, pull files
- [x] Selective push/pull re-checks only the chosen files; warning before pulling part of a core, plugin or theme update

## Next

- [ ] Group server changes by WordPress core, plugin and theme, with "pull this folder"
- [ ] Keep long change lists fast (render only what's visible, or "show more")
- [ ] Cancel a DDEV start

## Orca plugin directory

- [ ] The plugin at the repo root: `orca-plugin.json` there, with the built worker and panel committed (installs run no build), and CI that checks the committed build matches the source and runs `orca plugin validate`
- [ ] Release script: version in the manifest matches the `vX.Y.Z` tag, `orca-plugin` topic, push the tag, check `onorca.dev/plugins/incompletebiped/orca-localdock`
- [ ] A hero image: GitHub social preview (1280×640, set in the repo settings), the manifest `cover` (16:10) and the top of the README
- [ ] README with a screenshot of the sidebar (site view with changes, the database section, the status bar), install steps, and an "Access it asks for" section. Screenshots use a made-up site (example.com), never a client's
- [ ] A 128×128 icon

## Features

- [ ] Live DDEV status from `docker events`
- [ ] "DDEV logs" and "Shell" buttons that open an Orca terminal (`ddev logs -f`, `ddev ssh`)
- [ ] Open a changed file, or its diff, in Orca's editor before pushing
- [ ] A database viewer (DDEV's Adminer add-on in Orca's browser)
- [ ] Plugin settings: transfer concurrency, include uploads by default, default database table groups
- [ ] Media (uploads) sync as its own optional step
- [ ] Companion WordPress plugin, reporting database-side changes on the live site
- [ ] Jump hosts (`ProxyJump`)
- [ ] A scripted end-to-end check through `orca plugin dev request`

## Waiting on Orca

See [docs/ORCA-GAPS.md](docs/ORCA-GAPS.md).

- [ ] Orca's SSH hosts and connections for plugins (LocalDock uses the SSH config until then)
- [ ] A host API for Orca's browser, to replace the CLI call used for links
- [ ] An "Add Project" source, and Source Control provider integration

## Non-goals

- Merging databases row by row. No WordPress tool does this reliably, so LocalDock pulls the whole database and pushes selected table groups, with backups.
- Hosts without SSH access.
