# Roadmap

## Done (foundation)

- [x] Sync engine: cPanel discovery, three-way change detection, file push/pull with conflict checks
- [x] Database: streamed pull, selective table-group push, server-side backup and rollback, serialization-safe URL rewrite
- [x] DDEV integration: config matched to the server's PHP and database versions, start/stop/describe, import, `wp search-replace`
- [x] Plugin worker state machine and Orca host adapter, with the gaps marked
- [x] Sidebar panel UI for every step, plus a browser preview
- [x] Source-Control-style tracking: local changes watched live, server changes kept from the last check
- [x] Missing media served from the live site, so uploads don't need to be pulled
- [x] Docker housekeeping: start/quit Docker Desktop, `ddev poweroff` after the last site stops, free space from old DDEV images
- [x] Manifest format 2 and Orca's host API 1: panel ↔ worker messaging with pushes, the focused project's folder, opening links, a status bar item

## Waiting on Orca

See [docs/ORCA-GAPS.md](docs/ORCA-GAPS.md).

- [ ] Orca SSH hosts: list and connect (gap 1)
- [ ] Commands and file transfer over Orca SSH (gap 2)
- [ ] A host API for Orca's browser, to replace the CLI call used for links (wishlist)

## After the gaps close

- [ ] End-to-end test against a real cPanel server
- [ ] Companion WordPress plugin, reporting database-side changes on the live site
- [ ] Media (uploads) sync as its own optional step (missing media already loads from the live site)
- [ ] Publish to Orca's plugin marketplace
- [ ] An "Add Project" source, and Source Control provider integration (if Orca adds those extension points)

## Non-goals

- Merging databases row by row. No WordPress tool does this reliably, so LocalDock pulls the whole database and pushes selected table groups, with backups.
- Hosts without SSH access.
