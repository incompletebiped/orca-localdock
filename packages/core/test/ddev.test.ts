import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ddev, ddevInstallLocations, normalizeStatus } from '../src/ddev/Ddev.js';
import type { CommandRunner, RunResult } from '../src/ddev/runner.js';
import { localWpConfig, sanitizeHtaccess, uploadsProxyHtaccess } from '../src/ddev/templates.js';
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

  it('never syncs DDEV and project metadata', () => {
    const m = new PathMatcher(excludePatterns());
    for (const p of ['.ddev/config.yaml', 'wp-config-ddev.php', '.git/HEAD', '.orca/x', 'wp-content/mu-plugins/localdock-dev.php']) {
      expect(m.excludes(p)).toBe(true);
    }
  });
});
