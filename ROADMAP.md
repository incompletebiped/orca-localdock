# Roadmap

## Done (foundation)

- [x] Sync engine: cPanel discovery, three-way change detection, file push/pull with conflict checks
- [x] Database: streamed pull, selective table-group push, server-side backup and rollback, serialization-safe URL rewrite
- [x] DDEV integration: config matched to the server's PHP and database versions, start/stop/describe, import, `wp search-replace`
- [x] Plugin worker state machine and Orca host adapter, with the gaps marked
- [x] Sidebar panel UI for every step, plus a browser preview

## Waiting on Orca

See [docs/ORCA-GAPS.md](docs/ORCA-GAPS.md).

- [ ] Panel ↔ worker messaging (gap 1)
- [ ] The active project's folder path (gap 2)
- [ ] Orca SSH hosts: list and connect (gap 3)
- [ ] Commands and file transfer over Orca SSH (gap 4)
- [ ] Open URLs in Orca's browser (gap 5)

## After the gaps close

- [ ] End-to-end test against a real cPanel server
- [ ] Companion WordPress plugin, reporting database-side changes on the live site
- [ ] Media (uploads) sync as its own optional step
- [ ] Publish to Orca's plugin marketplace
- [ ] An "Add Project" source, and Source Control provider integration (if Orca adds those extension points)

## Non-goals

- Merging databases row by row. No WordPress tool does this reliably, so LocalDock pulls the whole database and pushes selected table groups, with backups.
- Hosts without SSH access.
