import { createReadStream, createWriteStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { LocalDockError } from '../errors.js';
import { silentLogger, type Logger } from '../log.js';
import { byteCounter, type ByteProgress } from '../util/format.js';
import { assertValid, isValidDbIdentifier, slugify } from '../util/shell.js';
import { processRunner, type CommandRunner, type RunOptions, type RunResult } from './runner.js';

type Io = Pick<RunOptions, 'stdin' | 'stdout' | 'signal'>;

export type DdevStatus = 'not-configured' | 'stopped' | 'starting' | 'running' | 'paused' | 'unhealthy' | 'unknown';

export interface DdevDescription {
  status: DdevStatus;
  /** Primary site URL, e.g. https://example-com.ddev.site */
  url?: string;
  mailpitUrl?: string;
  /** All published URLs DDEV reports. */
  urls: string[];
}

export interface DdevConfigOptions {
  projectName: string;
  /** Match the server, e.g. `8.2`. */
  phpVersion?: string;
  /** e.g. `mysql:8.0` or `mariadb:10.11`. */
  database?: string;
}

export interface DdevCheck {
  /** Installed DDEV version, or null when DDEV isn't installed. */
  version: string | null;
  /** DDEV is installed but can't reach Docker (e.g. Docker Desktop isn't running). */
  dockerError?: string;
  /** DDEV is installed but `ddev version` failed for another reason. */
  error?: string;
}

/** Parse the JSON objects in DDEV's `-j` output (one per line), skipping anything else. */
function jsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    try {
      const o: unknown = JSON.parse(line);
      if (o && typeof o === 'object') out.push(o as Record<string, unknown>);
    } catch {
      // Not JSON.
    }
  }
  return out;
}

/** DDEV's own database credentials inside its db container. */
export const DDEV_DB = { name: 'db', user: 'db', password: 'db' } as const;

const describeSchema = z.object({
  raw: z
    .object({
      status: z.string().optional(),
      primary_url: z.string().optional(),
      urls: z.array(z.string()).nullable().optional(),
      mailpit_https_url: z.string().optional(),
      mailpit_url: z.string().optional(),
    })
    .passthrough(),
});

/**
 * Thin wrapper over the `ddev` CLI. Every call runs `ddev` directly with an
 * argument array (no shell) in the project folder.
 */
export class Ddev {
  private readonly log: Logger;
  private binary: string;
  /** The environment DDEV runs with: see ddevEnv(). */
  private env: NodeJS.ProcessEnv = ddevEnv();
  private readonly locations: readonly string[];

  constructor(
    private readonly runner: CommandRunner = processRunner,
    options: { logger?: Logger; binary?: string; /** Where to look when `ddev` isn't on PATH. */ locations?: readonly string[] } = {},
  ) {
    this.log = (options.logger ?? silentLogger).child('ddev');
    this.binary = options.binary ?? 'ddev';
    this.locations = options.binary ? [] : (options.locations ?? ddevInstallLocations());
  }

  private ddev(cwd: string, args: string[], io: Io = {}): Promise<RunResult> {
    this.log.debug(`ddev ${args.join(' ')}`);
    return this.runner.run(this.binary, args, { cwd, env: this.env, ...io });
  }

  private async must(cwd: string, args: string[], what: string, io?: Io): Promise<RunResult> {
    const r = await this.ddev(cwd, args, io);
    if (r.code !== 0) {
      throw new LocalDockError(`${what} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`, 'DOCKER_START_FAILED');
    }
    return r;
  }

  /** DDEV version, or null when DDEV isn't installed. */
  async version(): Promise<string | null> {
    return (await this.check()).version;
  }

  /**
   * Whether DDEV is installed, and whether Docker is reachable. `ddev version`
   * fails when Docker isn't running (common right after a reboot) but still
   * prints its version, so that case is reported as `dockerError`, not as
   * "not installed".
   */
  async check(): Promise<DdevCheck> {
    let r = await this.runner.run(this.binary, ['version', '-j'], { env: this.env });
    // Not on PATH (127): an app started before DDEV was installed keeps its old PATH. Try where installers put it.
    if (r.code === 127) {
      const found = await firstExisting(this.locations);
      if (!found) return { version: null };
      this.useBinary(found);
      r = await this.runner.run(this.binary, ['version', '-j'], { env: this.env });
    }
    const version = jsonLines(r.stdout).map((o) => (o['raw'] as Record<string, unknown> | undefined)?.['DDEV version']).find((v) => typeof v === 'string') as
      | string
      | undefined;
    if (r.code === 0) return { version: version ?? 'unknown' };
    if (!version) return { version: null };
    const fatal = jsonLines(r.stderr).find((o) => o['level'] === 'fatal')?.['msg'];
    const message = (typeof fatal === 'string' ? fatal : r.stderr).trim().split('\n')[0]!;
    return /docker/i.test(message) ? { version, dockerError: message } : { version, error: message };
  }

  private useBinary(binary: string): void {
    this.binary = binary;
    this.env = ddevEnv(process.env, process.platform, path.dirname(binary));
    this.log.info(`Using DDEV at ${binary} (not on PATH)`);
  }

  /**
   * Configure the project as WordPress with Apache (cPanel servers run Apache,
   * so .htaccess rules behave the same locally).
   */
  async configure(projectDir: string, opts: DdevConfigOptions): Promise<void> {
    const args = [
      'config',
      '--project-type=wordpress',
      '--docroot=.',
      `--project-name=${slugify(opts.projectName)}`,
      '--webserver-type=apache-fpm',
    ];
    if (opts.phpVersion && /^\d+\.\d+$/.test(opts.phpVersion)) args.push(`--php-version=${opts.phpVersion}`);
    if (opts.database && /^(mysql|mariadb):\d+(\.\d+)?$/.test(opts.database)) args.push(`--database=${opts.database}`);
    await this.must(projectDir, args, 'ddev config');
  }

  async start(projectDir: string, signal?: AbortSignal): Promise<void> {
    await this.must(projectDir, ['start', '-y'], 'ddev start', { signal });
  }

  async stop(projectDir: string): Promise<void> {
    await this.must(projectDir, ['stop'], 'ddev stop');
  }

  /** Remove the project's containers and database (no snapshot). Files are left alone. */
  async delete(projectDir: string): Promise<void> {
    await this.must(projectDir, ['delete', '--omit-snapshot', '--yes'], 'ddev delete');
  }

  async describe(projectDir: string): Promise<DdevDescription> {
    const r = await this.ddev(projectDir, ['describe', '-j']);
    if (r.code !== 0) {
      return { status: /not.*found|no project|could not find/i.test(r.stderr + r.stdout) ? 'not-configured' : 'unknown', urls: [] };
    }
    // ddev -j prints one JSON log object per line; the describe payload is the one with `raw`.
    for (const line of r.stdout.split('\n').reverse()) {
      if (!line.includes('"raw"')) continue;
      try {
        const { raw } = describeSchema.parse(JSON.parse(line));
        return {
          status: normalizeStatus(raw.status),
          url: raw.primary_url,
          mailpitUrl: raw.mailpit_https_url ?? raw.mailpit_url,
          urls: raw.urls ?? [],
        };
      } catch {
        // Keep looking.
      }
    }
    return { status: 'unknown', urls: [] };
  }

  /** Replace the local database with a SQL dump. */
  /** Import a SQL file, streamed on stdin so progress can be counted. */
  async importDb(projectDir: string, sqlFile: string, onProgress?: ByteProgress): Promise<void> {
    const count = byteCounter(onProgress, (await stat(sqlFile)).size);
    const counted = new Transform({
      transform(chunk: Buffer, _enc, done) {
        count.add(chunk.length);
        done(null, chunk);
      },
    });
    await this.must(projectDir, ['import-db'], 'ddev import-db', { stdin: createReadStream(sqlFile).pipe(counted) });
    count.flush();
  }

  /** Dump selected tables (or all) from the local database to a file (mode 0600). */
  async exportTables(projectDir: string, outFile: string, tables: readonly string[] = []): Promise<void> {
    for (const t of tables) assertValid('table name', t, isValidDbIdentifier);
    const out = createWriteStream(outFile, { mode: 0o600 });
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    const r = await this.ddev(
      projectDir,
      ['exec', '-s', 'db', 'mysqldump', `-u${DDEV_DB.user}`, `-p${DDEV_DB.password}`, '--single-transaction',
        '--no-tablespaces', '--default-character-set=utf8mb4', DDEV_DB.name, ...tables],
      { stdout: out },
    );
    out.end();
    await done;
    if (r.code !== 0) throw new LocalDockError(`Local mysqldump failed: ${r.stderr.trim()}`, 'DB_EXPORT_FAILED');
  }

  async listTables(projectDir: string): Promise<string[]> {
    const r = await this.must(projectDir, ['exec', '-s', 'db', 'mysql', `-u${DDEV_DB.user}`, `-p${DDEV_DB.password}`,
      '-N', '-B', '-e', 'SHOW TABLES', DDEV_DB.name], 'Listing local tables');
    return r.stdout.split('\n').map((l) => l.trim()).filter(isValidDbIdentifier);
  }

  /**
   * URL search-replace with DDEV's bundled WP-CLI (serialization-safe, and it
   * runs inside WordPress so serialized objects are handled too).
   */
  async searchReplace(projectDir: string, pairs: ReadonlyArray<[string, string]>): Promise<void> {
    for (const [from, to] of pairs) {
      await this.must(
        projectDir,
        ['wp', 'search-replace', from, to, '--all-tables-with-prefix', '--skip-columns=guid', '--precise', '--quiet'],
        'wp search-replace',
      );
    }
  }

  /** Stream a SQL file into the local database (no DROP of other tables). */
  async runSql(projectDir: string, sqlFile: string): Promise<void> {
    await this.must(projectDir, ['exec', '-s', 'db', 'mysql', `-u${DDEV_DB.user}`, `-p${DDEV_DB.password}`, DDEV_DB.name],
      'Local SQL import', { stdin: createReadStream(sqlFile) });
  }
}

export function normalizeStatus(s: string | undefined): DdevStatus {
  switch ((s ?? '').toLowerCase()) {
    case 'running':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'paused':
      return 'paused';
    case 'starting':
      return 'starting';
    case 'unhealthy':
      return 'unhealthy';
    case '':
      return 'unknown';
    default:
      return /stopped|not running/i.test(s ?? '') ? 'stopped' : 'unknown';
  }
}

/** Where DDEV's installers put the binary, for when it isn't on PATH. */
export function ddevInstallLocations(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (platform === 'win32') {
    const win = windowsDirs(env, home);
    return [path.win32.join(win.LOCALAPPDATA, 'Programs', 'DDEV', 'ddev.exe'), path.win32.join(win.ProgramFiles, 'DDEV', 'ddev.exe')];
  }
  // GUI apps on macOS don't get Homebrew's PATH.
  return ['/opt/homebrew/bin/ddev', '/usr/local/bin/ddev', '/home/linuxbrew/.linuxbrew/bin/ddev', '/usr/bin/ddev'];
}

/**
 * The environment to run DDEV with. Hosts may start us with a trimmed
 * environment (Orca passes plugin workers only PATH, HOME, USERPROFILE, TEMP
 * and a few more), but on Windows DDEV, Docker and mkcert need the standard
 * user folders, so missing ones are filled in. `extraPath` goes first on PATH.
 */
export function ddevEnv(base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, extraPath?: string, home = os.homedir()): NodeJS.ProcessEnv {
  const env = { ...base };
  const keyOf = (name: string) => Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  if (platform === 'win32') {
    for (const [name, value] of Object.entries(windowsDirs(base, home))) if (!keyOf(name)) env[name] = value;
    if (!keyOf('USERNAME')) env['USERNAME'] = os.userInfo().username;
  }
  if (extraPath) {
    const key = keyOf('PATH') ?? 'PATH';
    env[key] = [extraPath, env[key]].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  }
  return env;
}

/** Standard Windows folders, from the environment when present, otherwise derived from the home folder. */
function windowsDirs(env: NodeJS.ProcessEnv, home: string): Record<'LOCALAPPDATA' | 'APPDATA' | 'ProgramFiles' | 'ProgramData', string> {
  const get = (name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name.toUpperCase())?.[1];
  const drive = get('SYSTEMDRIVE') ?? 'C:';
  return {
    LOCALAPPDATA: get('LOCALAPPDATA') ?? path.win32.join(home, 'AppData', 'Local'),
    APPDATA: get('APPDATA') ?? path.win32.join(home, 'AppData', 'Roaming'),
    ProgramFiles: get('ProgramFiles') ?? path.win32.join(`${drive}\\`, 'Program Files'),
    ProgramData: get('ProgramData') ?? path.win32.join(`${drive}\\`, 'ProgramData'),
  };
}

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const p of paths) {
    try {
      await access(p);
      return p;
    } catch {
      // Not there.
    }
  }
  return undefined;
}
