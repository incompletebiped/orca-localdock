import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { LocalDockError } from '../errors.js';
import { registerSecret } from '../log.js';
import type { RemoteFs, RemoteShell } from '../ssh/types.js';
import { assertSafeRemoteDir } from '../util/remotePath.js';
import { assertValid, isValidDbHost, isValidDbIdentifier, shq } from '../util/shell.js';
import { parseWpConfig } from '../discovery/wpConfig.js';
import { parseSearchReplaceOutput, searchReplaceScript, type DbConnection } from './searchReplace.js';

export interface DbCredentials {
  name: string;
  user: string;
  password: string;
  /** DB_HOST as written in wp-config.php. */
  host: string;
  tablePrefix: string;
}

/**
 * Read DB credentials from the site's wp-config.php (in the docroot, or one
 * level up, which WordPress also supports). The values are validated and
 * returned in memory only; they're never persisted by LocalDock.
 */
export async function readRemoteDbCredentials(sftp: RemoteFs, docroot: string): Promise<DbCredentials> {
  const root = assertSafeRemoteDir(docroot);
  const parent = root.slice(0, root.lastIndexOf('/')) || '/';
  let source: string | undefined;
  for (const candidate of [`${root}/wp-config.php`, `${parent}/wp-config.php`]) {
    try {
      source = (await sftp.readFile(candidate, 512 * 1024)).toString('utf-8');
      break;
    } catch {
      // Try the next location.
    }
  }
  if (source === undefined) {
    throw new LocalDockError(`No wp-config.php found for ${root}`, 'NOT_FOUND');
  }
  const v = parseWpConfig(source);
  if (v.nonLiteral.length > 0 || !v.dbName || !v.dbUser || v.dbPassword === undefined) {
    throw new LocalDockError(
      `Couldn't read database settings from wp-config.php` +
        (v.nonLiteral.length ? ` (${v.nonLiteral.join(', ')} aren't plain strings)` : ''),
      'DB_EXPORT_FAILED',
    );
  }
  registerSecret(v.dbPassword);
  return {
    name: assertValid('database name', v.dbName, isValidDbIdentifier),
    user: assertValid('database user', v.dbUser, isValidDbIdentifier),
    password: v.dbPassword,
    host: assertValid('database host', v.dbHost ?? 'localhost', isValidDbHost),
    tablePrefix: assertValid('table prefix', v.tablePrefix ?? 'wp_', (p) => /^[A-Za-z0-9_]{1,32}$/.test(p)),
  };
}

/** Split DB_HOST into host/port/socket. */
export function parseDbHost(dbHost: string): { host: string; port?: number; socket?: string } {
  const sock = dbHost.match(/^([^:]*):(\/.+)$/);
  if (sock) return { host: sock[1] || 'localhost', socket: sock[2] };
  const v6 = dbHost.match(/^(\[[^\]]+\])(?::(\d+))?$/);
  if (v6) return { host: v6[1]!, ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  const idx = dbHost.lastIndexOf(':');
  if (idx > -1) return { host: dbHost.slice(0, idx), port: Number(dbHost.slice(idx + 1)) };
  return { host: dbHost };
}

function optionFileValue(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

/** Contents of a MySQL client option file for these credentials. */
export function buildOptionFile(creds: DbCredentials): string {
  const { host, port, socket } = parseDbHost(creds.host);
  const lines = ['[client]', `user=${optionFileValue(creds.user)}`, `password=${optionFileValue(creds.password)}`];
  lines.push(`host=${optionFileValue(host.replace(/^\[|\]$/g, ''))}`);
  if (port) lines.push(`port=${port}`);
  if (socket) lines.push(`socket=${optionFileValue(socket)}`);
  return lines.join('\n') + '\n';
}

/**
 * Run `fn` with a MySQL option file holding the credentials. The file is
 * created with mode 0600 in a 0700 directory in the SSH user's home, so the
 * password never appears in a command line or a world-readable temp dir,
 * and it's removed afterwards.
 */
export async function withOptionFile<T>(
  shell: RemoteShell,
  sftp: RemoteFs,
  creds: DbCredentials,
  fn: (optionFile: string) => Promise<T>,
): Promise<T> {
  const home = await sftp.realpath('.');
  const dir = `${assertSafeRemoteDir(home)}/.localdock-tmp`;
  const mk = await shell.exec(`umask 077 && mkdir -p ${shq(dir)} && chmod 700 ${shq(dir)}`);
  if (mk.code !== 0) {
    throw new LocalDockError(`Couldn't create ${dir}: ${mk.stderr.trim()}`, 'REMOTE_COMMAND_FAILED');
  }
  const file = `${dir}/${randomBytes(12).toString('hex')}.cnf`;
  await sftp.writeFile(file, buildOptionFile(creds), 0o600);
  try {
    return await fn(file);
  } finally {
    await sftp.unlink(file).catch(() => {});
  }
}

const DUMP_FLAGS = [
  '--single-transaction',
  '--quick',
  '--routines',
  '--triggers',
  '--no-tablespaces',
  '--default-character-set=utf8mb4',
];

/** Stream a mysqldump of the remote database (optionally only `tables`) to a local file (mode 0600). */
export async function dumpRemoteDatabase(
  shell: RemoteShell,
  sftp: RemoteFs,
  creds: DbCredentials,
  localFile: string,
  options: { tables?: readonly string[]; signal?: AbortSignal } = {},
): Promise<void> {
  const tables = (options.tables ?? []).map((t) => assertValid('table name', t, isValidDbIdentifier));
  await withOptionFile(shell, sftp, creds, async (cnf) => {
    const out = createWriteStream(localFile, { mode: 0o600 });
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    const cmd = ['mysqldump', `--defaults-extra-file=${cnf}`, ...DUMP_FLAGS, creds.name, ...tables].map(shq).join(' ');
    const res = await shell.exec(cmd, { stdout: out, signal: options.signal });
    out.end();
    await done;
    if (res.code !== 0) {
      throw new LocalDockError(`mysqldump failed: ${res.stderr.trim() || `exit ${res.code}`}`, 'DB_EXPORT_FAILED');
    }
  });
}

/** Import a local SQL file into the remote database by streaming it to `mysql` over SSH. */
export async function importRemoteDatabase(
  shell: RemoteShell,
  sftp: RemoteFs,
  creds: DbCredentials,
  localFile: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await withOptionFile(shell, sftp, creds, async (cnf) => {
    const cmd = ['mysql', `--defaults-extra-file=${cnf}`, '--default-character-set=utf8mb4', creds.name].map(shq).join(' ');
    const res = await shell.exec(cmd, { stdin: createReadStream(localFile), signal: options.signal });
    if (res.code !== 0) {
      throw new LocalDockError(`MySQL import failed: ${res.stderr.trim() || `exit ${res.code}`}`, 'DB_IMPORT_FAILED');
    }
  });
}

export async function listRemoteTables(shell: RemoteShell, sftp: RemoteFs, creds: DbCredentials): Promise<string[]> {
  return withOptionFile(shell, sftp, creds, async (cnf) => {
    const cmd = ['mysql', `--defaults-extra-file=${cnf}`, '-N', '-B', '-e', 'SHOW TABLES', creds.name].map(shq).join(' ');
    const res = await shell.exec(cmd);
    if (res.code !== 0) {
      throw new LocalDockError(`Listing tables failed: ${res.stderr.trim()}`, 'DB_EXPORT_FAILED');
    }
    return res.stdout.split('\n').map((l) => l.trim()).filter((l) => isValidDbIdentifier(l));
  });
}

export interface RemoteBackup {
  path: string;
  createdAt: string;
}

/**
 * Take a gzipped backup of the whole remote database into
 * `~/.localdock-backups/` (mode 0600). Done before every database push.
 */
export async function backupRemoteDatabase(
  shell: RemoteShell,
  sftp: RemoteFs,
  creds: DbCredentials,
  options: { signal?: AbortSignal } = {},
): Promise<RemoteBackup> {
  const home = assertSafeRemoteDir(await sftp.realpath('.'));
  const dir = `${home}/.localdock-backups`;
  const createdAt = new Date().toISOString();
  const file = `${dir}/${creds.name}-${createdAt.replace(/[:.]/g, '-')}.sql.gz`;
  await withOptionFile(shell, sftp, creds, async (cnf) => {
    const dump = ['mysqldump', `--defaults-extra-file=${cnf}`, ...DUMP_FLAGS, creds.name].map(shq).join(' ');
    const cmd = `umask 077 && mkdir -p ${shq(dir)} && set -o pipefail && ${dump} | gzip > ${shq(file)}`;
    const res = await shell.exec(`bash -c ${shq(cmd)}`, { signal: options.signal });
    if (res.code !== 0) {
      await shell.exec(`rm -f ${shq(file)}`).catch(() => {});
      throw new LocalDockError(`Database backup failed: ${res.stderr.trim() || `exit ${res.code}`}`, 'DB_EXPORT_FAILED');
    }
  });
  return { path: file, createdAt };
}

/** Restore a backup taken by backupRemoteDatabase(). */
export async function restoreRemoteBackup(
  shell: RemoteShell,
  sftp: RemoteFs,
  creds: DbCredentials,
  backupPath: string,
): Promise<void> {
  if (!/\/\.localdock-backups\/[A-Za-z0-9_.-]+\.sql\.gz$/.test(backupPath)) {
    throw new LocalDockError('Not a LocalDock backup path', 'UNSAFE_INPUT', false);
  }
  await withOptionFile(shell, sftp, creds, async (cnf) => {
    const mysql = ['mysql', `--defaults-extra-file=${cnf}`, '--default-character-set=utf8mb4', creds.name].map(shq).join(' ');
    const cmd = `set -o pipefail && gunzip -c ${shq(backupPath)} | ${mysql}`;
    const res = await shell.exec(`bash -c ${shq(cmd)}`);
    if (res.code !== 0) {
      throw new LocalDockError(`Restore failed: ${res.stderr.trim() || `exit ${res.code}`}`, 'DB_IMPORT_FAILED');
    }
  });
}

const FIND_PHP =
  'PHP_BIN=""; for p in php php83 php82 php81 php80 php74 /usr/local/bin/php /usr/bin/php; do ' +
  'command -v "$p" >/dev/null 2>&1 && PHP_BIN=$(command -v "$p") && break; done; ' +
  'if [ -z "$PHP_BIN" ]; then for f in /opt/cpanel/ea-php*/root/usr/bin/php; do [ -x "$f" ] && PHP_BIN="$f"; done; fi; ' +
  '[ -n "$PHP_BIN" ] || { echo "No PHP binary found on the server" >&2; exit 127; }; ' +
  'exec "$PHP_BIN" -d memory_limit=1024M';

/** Run the serialization-safe URL search-replace on the remote database. The script travels on stdin. */
export async function searchReplaceRemote(
  shell: RemoteShell,
  creds: DbCredentials,
  tables: readonly string[],
  pairs: ReadonlyArray<[string, string]>,
): Promise<number> {
  const { host, port, socket } = parseDbHost(creds.host);
  const db: DbConnection = { host, name: creds.name, user: creds.user, password: creds.password, ...(port ? { port } : {}), ...(socket ? { socket } : {}) };
  const script = searchReplaceScript({ db, tables, tablePrefix: creds.tablePrefix, pairs });
  const res = await shell.exec(FIND_PHP, { stdin: script });
  const out = parseSearchReplaceOutput(res.stdout);
  if (!out.ok) {
    throw new LocalDockError(`URL rewrite on the server failed: ${out.error || res.stderr.trim()}`, 'DB_IMPORT_FAILED');
  }
  return out.rows;
}
