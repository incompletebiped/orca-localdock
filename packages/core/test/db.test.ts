import { describe, it, expect } from 'vitest';
import { groupTables, tableGroup, defaultPushGroups } from '../src/db/tableGroups.js';
import { parseSearchReplaceOutput, searchReplaceScript, urlReplacePairs } from '../src/db/searchReplace.js';
import { buildOptionFile, parseDbHost, readRemoteDbCredentials, withOptionFile } from '../src/db/remoteDb.js';
import type { RemoteFs, RemoteShell } from '../src/ssh/types.js';

describe('table groups', () => {
  it('classifies core, commerce, plugin and foreign tables', () => {
    expect(tableGroup('wp_posts', 'wp_')).toBe('content');
    expect(tableGroup('wp_options', 'wp_')).toBe('config');
    expect(tableGroup('wp_usermeta', 'wp_')).toBe('users');
    expect(tableGroup('wp_comments', 'wp_')).toBe('comments');
    expect(tableGroup('wp_wc_orders', 'wp_')).toBe('commerce');
    expect(tableGroup('wp_woocommerce_order_items', 'wp_')).toBe('commerce');
    expect(tableGroup('wp_gf_entry', 'wp_')).toBe('commerce');
    expect(tableGroup('wp_yoast_indexable', 'wp_')).toBe('plugins');
    expect(tableGroup('legacy_stuff', 'wp_')).toBe('other');
  });
  it('groups a table list and defaults to content + settings', () => {
    const g = groupTables(['x_posts', 'x_options', 'x_users'], 'x_');
    expect(g.content).toEqual(['x_posts']);
    expect(g.config).toEqual(['x_options']);
    expect(g.users).toEqual(['x_users']);
    expect(defaultPushGroups()).toEqual(['content', 'config']);
  });
});

describe('URL search-replace', () => {
  it('builds http/https and JSON-escaped pairs', () => {
    expect(urlReplacePairs('https://example.com/', 'http://localhost:10080')).toEqual([
      ['https://example.com', 'http://localhost:10080'],
      ['https:\\/\\/example.com', 'http:\\/\\/localhost:10080'],
      ['http://example.com', 'http://localhost:10080'],
      ['http:\\/\\/example.com', 'http:\\/\\/localhost:10080'],
    ]);
  });

  it('embeds parameters as base64 so no value can break out of the PHP source', () => {
    const script = searchReplaceScript({
      db: { host: 'localhost', name: 'db', user: 'u', password: `p'"; system('id'); //` },
      tables: ['wp_posts'],
      tablePrefix: 'wp_',
      pairs: [['a', 'b']],
    });
    expect(script).not.toContain('system(');
    expect(script).toContain("'allowed_classes' => false");
    const b64 = script.match(/base64_decode\('([^']+)'\)/)![1]!;
    expect(JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')).db.password).toBe(`p'"; system('id'); //`);
  });

  it('parses the result line', () => {
    expect(parseSearchReplaceOutput('PHP Warning: x\n{"ok":true,"rows":12}\n')).toEqual({ ok: true, rows: 12 });
    expect(parseSearchReplaceOutput('{"ok":false,"error":"denied"}')).toEqual({ ok: false, error: 'denied' });
    expect(parseSearchReplaceOutput('')).toMatchObject({ ok: false });
  });
});

describe('MySQL option files', () => {
  it('splits DB_HOST forms', () => {
    expect(parseDbHost('localhost')).toEqual({ host: 'localhost' });
    expect(parseDbHost('db.example.com:3307')).toEqual({ host: 'db.example.com', port: 3307 });
    expect(parseDbHost('localhost:/var/lib/mysql/mysql.sock')).toEqual({ host: 'localhost', socket: '/var/lib/mysql/mysql.sock' });
    expect(parseDbHost('[::1]:3306')).toEqual({ host: '[::1]', port: 3306 });
  });

  it('quotes and escapes values', () => {
    const file = buildOptionFile({ name: 'db', user: 'u', password: 'a\\b"c\nd', host: 'localhost:3307', tablePrefix: 'wp_' });
    expect(file).toBe('[client]\nuser="u"\npassword="a\\\\b"c\\nd"\nhost="localhost"\nport=3307\n');
  });

  it('writes the option file privately and always removes it', async () => {
    const calls: string[] = [];
    let written: { path: string; mode?: number } | undefined;
    let removed = '';
    const shell: RemoteShell = { exec: async (c) => (calls.push(c), { code: 0, stdout: '', stderr: '' }) };
    const sftp = {
      realpath: async () => '/home/acct',
      writeFile: async (p: string, _d: string, mode?: number) => void (written = { path: p, mode }),
      unlink: async (p: string) => void (removed = p),
    } as unknown as RemoteFs;
    await expect(
      withOptionFile(shell, sftp, { name: 'd', user: 'u', password: 'p', host: 'localhost', tablePrefix: 'wp_' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls[0]).toBe(`umask 077 && mkdir -p '/home/acct/.localdock-tmp' && chmod 700 '/home/acct/.localdock-tmp'`);
    expect(written!.path).toMatch(/^\/home\/acct\/\.localdock-tmp\/[0-9a-f]{24}\.cnf$/);
    expect(written!.mode).toBe(0o600);
    expect(removed).toBe(written!.path);
  });
});

describe('readRemoteDbCredentials', () => {
  const sftpWith = (files: Record<string, string>) =>
    ({
      readFile: async (p: string) => {
        if (!(p in files)) throw new Error('No such file');
        return Buffer.from(files[p]!);
      },
    }) as unknown as RemoteFs;

  it('reads wp-config.php from the docroot or its parent', async () => {
    const cfg = `<?php define('DB_NAME','acct_db'); define('DB_USER','acct_u'); define('DB_PASSWORD','pw'); $table_prefix='wp_';`;
    expect(await readRemoteDbCredentials(sftpWith({ '/home/acct/wp-config.php': cfg }), '/home/acct/public_html')).toEqual({
      name: 'acct_db',
      user: 'acct_u',
      password: 'pw',
      host: 'localhost',
      tablePrefix: 'wp_',
    });
  });

  it('rejects unsafe identifiers from a tampered wp-config.php', async () => {
    const cfg = `<?php define('DB_NAME','x; rm -rf /'); define('DB_USER','u'); define('DB_PASSWORD','p');`;
    await expect(readRemoteDbCredentials(sftpWith({ '/home/a/public_html/wp-config.php': cfg }), '/home/a/public_html')).rejects.toThrow(
      /Invalid database name/,
    );
  });
});
