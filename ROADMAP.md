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
- [x] Change lists grouped by WordPress core, plugin and theme, with one-click group push/pull; long lists stay fast
- [x] Cancel a DDEV start
- [x] Security review and fixes (see SECURITY.md)
- [x] Resumable pulls; a dropped connection fails the step instead of hanging
- [x] Parallel archive downloads for distant servers

## Next

- [ ] Do file and database work as the cPanel account (`sudo -u`) instead of root, even in a root session
- [ ] Live DDEV status from `docker events`

## Orca plugin directory

- [x] The plugin at the repo root: `orca-plugin.json` there, with the built worker and panel committed in `plugin/` (installs run no build), and CI that checks the committed build matches the source
- [x] First release tag (`v0.1.0`) and the `orca-plugin` topic
- [ ] Run `orca plugin validate` in CI (needs the Orca CLI on the runner)
- [ ] Release script: version in the manifest matches the `vX.Y.Z` tag, push the tag, check `orca.dev/plugins/incompletebiped/orca-localdock`
- [x] A hero image: the manifest `cover` (16:10) and the top of the README, plus a GitHub social preview image (`docs/media/social-preview.png`)
- [ ] Set the social preview in the repo settings (Settings → General → Social preview; GitHub has no API for it)
- [x] Screenshots of the sidebar in the README and the manifest, from made-up sample data (example.com)
- [x] README install steps and an "Access it asks for" section
- [ ] A status bar screenshot
- [x] An icon (256×256)

## Features

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

- [ ] Orca's SSH hosts and connections for plugins (LocalDock uses the SSH config until then). What LocalDock would gain is in the README's "Roadmap: using Orca's SSH hosts".
- [ ] A host API for Orca's browser, to replace the CLI call used for links
- [ ] An "Add Project" source, and Source Control provider integration

## Non-goals

- Merging databases row by row. No WordPress tool does this reliably, so LocalDock pulls the whole database and pushes selected table groups, with backups.
- Hosts without SSH access.
