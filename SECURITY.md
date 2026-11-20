# Security

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through [GitHub Security Advisories](../../security/advisories/new) for this repository.

## What LocalDock does on a server

LocalDock acts with the SSH access of the host you choose from your SSH config. If that host logs in as root on a WHM server, LocalDock can reach every account on it. It uses that access only to:

- list cPanel accounts and domains (`whmapi1`, `uapi`)
- read, write and delete files inside the docroot of the site you pulled (listing it with `find`, downloading with `tar -cz` streamed over SSH)
- dump and import that site's database (`mysqldump`, `mysql`)
- take a gzipped database backup in the SSH user's `~/.localdock-backups/` before any database push (`/root/.localdock-backups/` for a root login)
- `chown` uploaded files back to the owning cPanel account (root sessions only)

It installs nothing on the server. If you can, log in as the cPanel account's own user rather than root: LocalDock then can't reach other accounts at all.

## How LocalDock connects

- It reads your SSH config the way `ssh` does (`ssh -G <alias>` resolves HostName, User, Port and IdentityFile, Include and Match included).
- It trusts a server only if its host key is in your `known_hosts` (read with `ssh-keygen -F`; `@revoked` keys are never trusted, `@cert-authority` lines are ignored). An unknown host is refused with a message to connect once with `ssh <alias>` in a terminal, where ssh shows you the fingerprint. A changed key is refused as a possible interception. LocalDock never adds or changes `known_hosts` entries.
- It logs in with your identity files, then your SSH agent, in the same order as `ssh`. Passphrase-protected keys need to be in the agent. Keys are read into the worker's memory for the connection only; nothing is stored.

## Threat model and mitigations

| Risk | Mitigation |
|---|---|
| Connecting to an impostor server | Only host keys already in your `known_hosts` are accepted; unknown or changed keys are refused. |
| A hostile file name, domain or `wp-config.php` value injecting shell commands | Remote commands quote every argument (`shq`). Account names, domains, database identifiers and hosts are validated. Panel actions can't carry shell text. |
| Push or delete escaping the site | Every path is normalized and confined to the docroot locally, and to the project folder on this machine. |
| A tampered download archive | Only regular files LocalDock asked for are unpacked, each through the same path confinement; links, devices and unrequested entries are skipped. |
| Overwriting someone's live edit | Before a push, the change set is recomputed against the server. Files changed on both sides are refused unless you explicitly choose a side. |
| A bad database push | A full backup is taken first. If the import or URL rewrite fails, it's restored automatically. One click rolls it back afterwards. |
| Production secrets on a laptop | Production's `wp-config.php` is never downloaded. Database passwords are read into memory when needed, passed to MySQL in a 0600 option file in a 0700 directory, deleted straight after, and masked in logs. |
| Object injection from database content | The server-side URL rewrite unserializes with `allowed_classes: false`. |
| A malicious site name scripting the panel | The panel builds its HTML from templates and escapes every string from the server or worker (`esc()`). The panel sandbox (no network access) adds a second layer. |
| Untrusted panel messages | The worker validates every action with a strict schema. A pull only accepts sites the worker discovered itself. Push and pull only take paths from a freshly computed change set (and group names the worker expands itself). A rollback only accepts this database's own backups. |
| The site's own code (running in DDEV) tampering with the project folder | LocalDock never runs a program from the project folder: bare program names are looked up only in absolute PATH folders (Windows would otherwise try the working folder first). The site's host, account, docroot and live URL are recorded in the plugin's private storage at pull time, and every server step refuses to run if `.localdock/state.json` no longer matches. |
| Symlinks planted by a cPanel user (root sessions) | A docroot must be its own real path (no symlink in it). Files are read only if they're regular files (no links, no devices), and the root `.htaccess` is copied only if it's a regular file. Uploads go to a temporary name and are renamed into place, so a link at the target is replaced, never written through. Directories are created only through real directories. |
| A hostile database server | Only a database on the server itself is used (`DB_HOST` must be localhost or loopback). The mysql client runs with `local-infile=0`, so a server can't ask it for local files. |
| Links opening something other than a web page | Only `http(s)` URLs are opened, in Orca's browser or the default one; `file:` and other schemes are refused. |
| A server sending endless output | Output held in memory is capped (64 MiB per command stream, 256 MiB for the file listing). Files are read only up to a size limit. File names in tar's list start with `./`, so none can be read as an option. |
| Personal data in database dumps | `.localdock/db.sql` is never synced and is ignored by git. Treat the project folder as sensitive. |
| A local copy emailing real users or calling live services | DDEV captures mail (Mailpit). WP-Cron is disabled locally. Cache plugins are disabled. |

## Repository hygiene

- No real hostnames, IPs, account names or domains in code, tests or docs. Use `example.com` and `203.0.113.0/24` (RFC 5737).
- gitleaks secret scanning runs in CI.
- No telemetry.
