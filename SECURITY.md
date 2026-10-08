# Security

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through [GitHub Security Advisories](../../security/advisories/new) for this repository.

## What LocalDock does on a server

LocalDock acts with the SSH access of the Orca SSH host you choose. If that host logs in as root on a WHM server, LocalDock can reach every account on it. It uses that access only to:

- list cPanel accounts and domains (`whmapi1`, `uapi`)
- read, write and delete files inside the docroot of the site you pulled
- dump and import that site's database (`mysqldump`, `mysql`)
- take a gzipped database backup in the account's `~/.localdock-backups/` before any database push
- `chown` uploaded files back to the owning cPanel account (root sessions only)

It installs nothing on the server.

## Threat model and mitigations

| Risk | Mitigation |
|---|---|
| A hostile file name, domain or `wp-config.php` value injecting shell commands | Remote commands quote every argument (`shq`). Account names, domains, database identifiers and hosts are validated. Panel actions can't carry shell text. |
| Push or delete escaping the site | Every path is normalized and confined to the docroot locally, and to the project folder on this machine. |
| Overwriting someone's live edit | Before a push, the change set is recomputed against the server. Files changed on both sides are refused unless you explicitly choose a side. |
| A bad database push | A full backup is taken first. If the import or URL rewrite fails, it's restored automatically. One click rolls it back afterwards. |
| Production secrets on a laptop | Production's `wp-config.php` is never downloaded. Database passwords are read into memory when needed, passed to MySQL in a 0600 option file in a 0700 directory, deleted straight after, and masked in logs. |
| Object injection from database content | The server-side URL rewrite unserializes with `allowed_classes: false`. |
| A malicious site name scripting the panel | The panel escapes every string from the server and builds no markup from data. The panel sandbox (no network access) adds a second layer. |
| Untrusted panel messages | The worker validates every action with a strict schema. A pull only accepts sites the worker discovered itself. |
| Personal data in database dumps | `.localdock/db.sql` is never synced and is ignored by git. Treat the project folder as sensitive. |
| A local copy emailing real users or calling live services | DDEV captures mail (Mailpit). WP-Cron is disabled locally. Cache plugins are disabled. |

## Repository hygiene

- No real hostnames, IPs, account names or domains in code, tests or docs. Use `example.com` and `203.0.113.0/24` (RFC 5737).
- gitleaks secret scanning runs in CI.
- No telemetry.
