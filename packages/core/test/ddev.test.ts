import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ddev, ddevEnv, ddevInstallLocations, dockerDesktopLocations, normalizeStatus } from '../src/ddev/Ddev.js';
import type { CommandRunner, RunResult } from '../src/ddev/runner.js';
import { devMuPlugin, localWpConfig, sanitizeHtaccess, uploadsProxyHtaccess } from '../src/ddev/templates.js';
import { phpVersionFromHtaccess } from '../src/operations/site.js';
import { PathMatcher } from '../src/util/glob.js';
import { excludePatterns } from '../src/sync/excludes.js';

function fakeRunner(reply: (args: readonly string[]) => Partial<RunResult> = () => ({})) {
  const calls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push({ command, args, cwd: options?.cwd });
      return { code: 0, stdout: '', stderr: '', ...reply(args) };
    },
  };
  return { runner, calls };
}

describe('finding DDEV off PATH', () => {
  it('knows where the installers put it', () => {
    expect(ddevInstallLocations('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' })).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Programs\\DDEV\\ddev.exe',
      'C:\\Program Files\\DDEV\\ddev.exe',
    ]);
    expect(ddevInstallLocations('darwin', {})).toContain('/opt/homebrew/bin/ddev');
    // Orca's plugin workers get no LOCALAPPDATA or ProgramFiles: derive them.
    expect(ddevInstallLocations('win32', { SYSTEMDRIVE: 'D:' }, 'D:\\Users\\u')).toEqual([
      'D:\\Users\\u\\AppData\\Local\\Programs\\DDEV\\ddev.exe',
      'D:\\Program Files\\DDEV\\ddev.exe',
    ]);
  });

  it('restores the Windows folders a trimmed environment lacks, without overriding real ones', () => {
    const env = ddevEnv({ Path: 'C:\\Windows', APPDATA: 'E:\\Roaming', USERNAME: 'u' }, 'win32', 'C:\\DDEV', 'C:\\Users\\u');
    expect(env).toMatchObject({
      Path: 'C:\\DDEV;C:\\Windows',
      APPDATA: 'E:\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      USERNAME: 'u',
    });
    expect(env).not.toHaveProperty('PATH');
    expect(ddevEnv({ PATH: '/usr/bin' }, 'linux')).toEqual({ PATH: '/usr/bin' });
  });

  it('falls back to an install location, with its folder first on PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-ddev-'));
    const exe = path.join(dir, 'ddev.exe');
    await fs.writeFile(exe, '');
    const calls: Array<{ command: string; path?: string }> = [];
    const runner: CommandRunner = {
      async run(command, args, options) {
        const env = options?.env;
        calls.push({ command, path: env && Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] });
        if (command === 'ddev') return { code: 127, stdout: '', stderr: 'spawn ddev ENOENT' };
        return { code: 0, stdout: JSON.stringify({ raw: { 'DDEV version': 'v1.25.4' } }), stderr: '' };
      },
    };
    const ddev = new Ddev(runner, { locations: [path.join(dir, 'missing.exe'), exe] });
    expect(await ddev.version()).toBe('v1.25.4');
    await ddev.stop('/p');
    expect(calls.map((c) => c.command)).toEqual(['ddev', exe, exe]);
    expect(calls[2]!.path!.split(path.delimiter)[0]).toBe(dir);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports not installed when it is nowhere, and never searches for an explicit binary', async () => {
    const missing: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: '' }) };
    expect(await new Ddev(missing, { locations: [path.join(os.tmpdir(), 'no-such-ddev')] }).version()).toBeNull();
    expect(await new Ddev(missing, { binary: '/custom/ddev' }).version()).toBeNull();
  });
});

describe('checking DDEV and Docker', () => {
  const fixture = (name: string) => fs.readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf-8');

  it('reports Docker not running (real `ddev version -j` output) instead of "not installed"', async () => {
    const [stdout, stderr] = await Promise.all([fixture('ddev-version-docker-down.stdout.txt'), fixture('ddev-version-docker-down.stderr.txt')]);
    const ddev = new Ddev({ run: async () => ({ code: 1, stdout, stderr }) }, { locations: [] });
    const check = await ddev.check();
    expect(check.version).toBe('v1.25.4');
    expect(check.dockerError).toMatch(/^Docker error: failed to connect to the docker API/);
    expect(await ddev.version()).toBe('v1.25.4');
  });

  it('reports not installed only when there is no DDEV at all', async () => {
    const ddev = new Ddev({ run: async () => ({ code: 127, stdout: '', stderr: 'spawn ddev ENOENT' }) }, { locations: [] });
    expect(await ddev.check()).toEqual({ version: null });
  });
});

describe('projects on drives Docker Desktop doesn’t mount', () => {
  it('mounts the project drive into Docker Desktop’s VM before starting, on Windows only', async () => {
    const { runner, calls } = fakeRunner();
    await new Ddev(runner, { binary: 'ddev', platform: 'win32' }).start('D:\\sites\\example');
    expect(calls.map((c) => c.command)).toEqual([expect.stringMatching(/System32[\\/]wsl\.exe$/i), 'ddev']);
    expect(calls[0]!.args.slice(0, 8)).toEqual(['-d', 'docker-desktop', '-u', 'root', '--cd', '/', '-e', 'sh']);
    const script = calls[0]!.args[9]!;
    expect(script).toContain('mount -t drvfs D: "$p"');
    expect(script).toContain('/tmp/docker-desktop-root/run/desktop/mnt/host/d /mnt/host/d');

    const linux = fakeRunner();
    await new Ddev(linux.runner, { binary: 'ddev', platform: 'linux' }).start('/sites/example');
    expect(linux.calls.map((c) => c.command)).toEqual(['ddev']);
  });

  it('still starts when the drive can’t be mounted, and leaves network paths alone', async () => {
    const { runner, calls } = fakeRunner((args) => (args[0] === '-d' ? { code: 1 } : {}));
    const ddev = new Ddev(runner, { binary: 'ddev', platform: 'win32' });
    await ddev.start('E:\\sites\\example');
    expect(calls.map((c) => c.args[0])).toEqual(['-d', 'start']);
    expect(await ddev.shareProjectDrive('\\\\server\\share\\site')).toBe(true);
  });
});

describe('starting Docker Desktop', () => {
  const up = { code: 0, stdout: JSON.stringify({ raw: { 'DDEV version': 'v1.25.4' } }), stderr: '' };
  const down = { code: 1, stdout: up.stdout, stderr: JSON.stringify({ level: 'fatal', msg: 'Docker error: failed to connect to the docker API' }) };

  it('knows where Docker Desktop is installed, even with a trimmed environment', () => {
    expect(dockerDesktopLocations('win32', { SYSTEMDRIVE: 'C:' }, 'C:\\Users\\u')).toEqual([
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Docker\\Docker\\Docker Desktop.exe',
    ]);
    expect(dockerDesktopLocations('darwin', {}, '/Users/u')).toEqual(['/Applications/Docker.app', '/Users/u/Applications/Docker.app']);
  });

  it('launches the first install it finds (macOS apps through `open`)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-docker-'));
    const exe = path.join(dir, 'Docker Desktop.exe');
    const app = path.join(dir, 'Docker.app');
    await fs.writeFile(exe, '');
    await fs.mkdir(app);
    const launched: Array<[string, readonly string[]]> = [];
    const launcher = async (command: string, args: readonly string[]) => void launched.push([command, args]);
    await new Ddev(fakeRunner().runner, { dockerLocations: [path.join(dir, 'nope.exe'), exe], launcher }).launchDocker();
    await new Ddev(fakeRunner().runner, { dockerLocations: [app], launcher }).launchDocker();
    expect(launched).toEqual([[exe, []], ['open', [app]]]);
    await expect(new Ddev(fakeRunner().runner, { dockerLocations: [path.join(dir, 'nope.exe')], launcher }).launchDocker()).rejects.toThrow(
      /Couldn’t find Docker Desktop/,
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('waits until DDEV reaches Docker, and gives up after the timeout or on cancel', async () => {
    let checks = 0;
    const waits: number[] = [];
    const ddev = new Ddev({ run: async () => (++checks < 3 ? down : up) }, { locations: [] });
    await ddev.waitForDocker({ intervalMs: 1, onWait: (s) => waits.push(s) });
    expect(checks).toBe(3);
    expect(waits).toHaveLength(2);

    const never = new Ddev({ run: async () => down }, { locations: [] });
    await expect(never.waitForDocker({ intervalMs: 1, timeoutMs: 5 })).rejects.toThrow(/still isn’t reachable/);
    const abort = new AbortController();
    const waiting = never.waitForDocker({ intervalMs: 10_000, signal: abort.signal });
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('Ddev', () => {
  it('configures a WordPress project on Apache matching the server versions', async () => {
    const { runner, calls } = fakeRunner();
    await new Ddev(runner).configure('/p', { projectName: 'www.Example.com', phpVersion: '8.2', database: 'mariadb:10.11' });
    expect(calls[0]).toEqual({
      command: 'ddev',
      cwd: '/p',
      args: ['config', '--project-type=wordpress', '--docroot=.', '--project-name=www-example-com', '--webserver-type=apache-fpm',
        '--php-version=8.2', '--database=mariadb:10.11'],
    });
  });

  it('ignores malformed versions instead of passing them through', async () => {
    const { runner, calls } = fakeRunner();
    await new Ddev(runner).configure('/p', { projectName: 'x', phpVersion: '8.2; rm -rf /', database: 'postgres:16' });
    expect(calls[0]!.args).not.toContain('--php-version=8.2; rm -rf /');
    expect(calls[0]!.args.some((a) => a.startsWith('--database'))).toBe(false);
  });

  it('parses ddev describe -j', async () => {
    const payload = {
      level: 'info',
      msg: '',
      raw: { status: 'running', primary_url: 'https://example-com.ddev.site', urls: ['https://example-com.ddev.site'], mailpit_https_url: 'https://example-com.ddev.site:8026' },
    };
    const { runner } = fakeRunner(() => ({ stdout: `{"level":"info","msg":"x"}\n${JSON.stringify(payload)}\n` }));
    expect(await new Ddev(runner).describe('/p')).toEqual({
      status: 'running',
      url: 'https://example-com.ddev.site',
      mailpitUrl: 'https://example-com.ddev.site:8026',
      urls: ['https://example-com.ddev.site'],
    });
  });

  it('reports an unconfigured project', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stderr: 'Could not find a project in /p' }));
    expect((await new Ddev(runner).describe('/p')).status).toBe('not-configured');
  });

  it('runs one wp search-replace per pair, skipping guid', async () => {
    const { runner, calls } = fakeRunner();
    await new Ddev(runner).searchReplace('/p', [['https://example.com', 'https://example-com.ddev.site']]);
    expect(calls[0]!.args).toEqual(['wp', 'search-replace', 'https://example.com', 'https://example-com.ddev.site',
      '--all-tables-with-prefix', '--skip-columns=guid', '--precise', '--quiet']);
  });

  it('throws with DDEV output when a command fails', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stderr: 'Docker is not running' }));
    await expect(new Ddev(runner).start('/p')).rejects.toThrow(/ddev start failed: Docker is not running/);
  });

  it('returns null version when DDEV is missing', async () => {
    const { runner } = fakeRunner(() => ({ code: 127 }));
    expect(await new Ddev(runner).version()).toBeNull();
  });

  it('normalizes statuses', () => {
    expect(normalizeStatus('running')).toBe('running');
    expect(normalizeStatus('stopped')).toBe('stopped');
    expect(normalizeStatus(undefined)).toBe('unknown');
  });
});

describe('local templates', () => {
  it('writes a local wp-config.php with the production prefix and no production secrets', () => {
    const cfg = localWpConfig('abc_');
    expect(cfg).toContain("$table_prefix = 'abc_';");
    expect(cfg).toContain("define( 'DISABLE_WP_CRON', true );");
    expect(cfg).toContain("require_once __DIR__ . '/wp-config-ddev.php';");
    expect(cfg).not.toMatch(/DB_PASSWORD/);
    expect(localWpConfig('abc_')).not.toBe(cfg); // fresh salts every time
  });

  it('removes HTTPS and canonical-host redirects but keeps permalinks', () => {
    const ht = ['RewriteEngine On', 'RewriteCond %{HTTPS} off', 'RewriteRule ^(.*)$ https://www.example.com/$1 [L,R=301]', 'RewriteRule . /index.php [L]'].join('\n');
    expect(sanitizeHtaccess(ht)).toBe(['RewriteEngine On', 'RewriteRule . /index.php [L]'].join('\n'));
  });

  it('proxies missing uploads to production', () => {
    expect(uploadsProxyHtaccess('https://example.com/')).toContain('https://example.com/wp-content/uploads/$1 [R=302,L]');
  });

  it('reads the site’s PHP version from its .htaccess handler', () => {
    expect(phpVersionFromHtaccess('# x-httpd-ea-php74\nAddHandler application/x-httpd-ea-php83 .php .php8')).toBe('8.3');
    expect(phpVersionFromHtaccess('AddHandler application/x-httpd-alt-php81___lsphp .php')).toBe('8.1');
    expect(phpVersionFromHtaccess('RewriteEngine On')).toBeUndefined();
  });

  it('hides PHP notices from pages (not from WP-CLI)', () => {
    expect(devMuPlugin('https://example.com')).toContain(`if ( PHP_SAPI !== 'cli' ) {\n\t@ini_set( 'display_errors', '0' );`);
  });

  it('also sends missing media to production from the mu-plugin, for when the .htaccess never reaches the server', () => {
    const php = devMuPlugin('https://example.com/');
    expect(php).toContain(`header( 'Location: ' . 'https://example.com' . $uri, true, 302 );`);
    expect(devMuPlugin("https://ex'ample.com\\")).toContain(`'https://ex\\'ample.com\\\\'`);
  });

  it('never syncs DDEV and project metadata', () => {
    const m = new PathMatcher(excludePatterns());
    for (const p of ['.ddev/config.yaml', 'wp-config-ddev.php', '.git/HEAD', '.orca/x', 'wp-content/mu-plugins/localdock-dev.php']) {
      expect(m.excludes(p)).toBe(true);
    }
  });
});
