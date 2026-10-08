import { describe, it, expect } from 'vitest';
import { parseWpConfig, parseWpVersion, stripPhpComments } from '../src/discovery/wpConfig.js';
import { parseWhmListAccts, parseUapiDomainsData } from '../src/discovery/cpanelApi.js';
import { PathMatcher } from '../src/util/glob.js';
import { excludePatterns } from '../src/sync/excludes.js';

describe('parseWpConfig', () => {
  it('reads string-literal DB settings and the table prefix', () => {
    const src = `<?php
// ** Database settings ** //
define( 'DB_NAME', 'acct_wp1' );
define('DB_USER', "acct_user");
define( 'DB_PASSWORD', 'it\\'s a "p@ss" // not a comment' );
define( 'DB_HOST', 'localhost:3307' );
$table_prefix = 'wpx_';
`;
    expect(parseWpConfig(src)).toEqual({
      dbName: 'acct_wp1',
      dbUser: 'acct_user',
      dbPassword: `it's a "p@ss" // not a comment`,
      dbHost: 'localhost:3307',
      tablePrefix: 'wpx_',
      nonLiteral: [],
    });
  });

  it('ignores commented-out defines and keeps the first definition', () => {
    const src = `<?php
/* define( 'DB_NAME', 'old_db' ); */
# define( 'DB_USER', 'old_user' );
define( 'DB_NAME', 'new_db' );
define( 'DB_NAME', 'ignored_redefinition' );
define( 'DB_USER', 'u' );`;
    const v = parseWpConfig(src);
    expect(v.dbName).toBe('new_db');
    expect(v.dbUser).toBe('u');
  });

  it('flags non-literal values instead of guessing', () => {
    const v = parseWpConfig(`<?php define('DB_PASSWORD', getenv('DB_PASS')); define('DB_HOST', "$host");`);
    expect(v.dbPassword).toBeUndefined();
    expect(v.nonLiteral).toEqual(['DB_PASSWORD', 'DB_HOST']);
  });

  it('decodes double-quoted escapes', () => {
    expect(parseWpConfig(`<?php define("DB_PASSWORD", "a\\"b\\\\c\\$d");`).dbPassword).toBe('a"b\\c$d');
  });

  it('strips comments but not string contents', () => {
    expect(stripPhpComments(`$a = 'x // y'; // gone\n$b = "#keep"; # gone`)).toBe(`$a = 'x // y'; \n$b = "#keep"; `);
  });

  it('reads the WordPress version', () => {
    expect(parseWpVersion(`<?php\n$wp_version = '6.8.1';\n$wp_db_version = 58975;`)).toBe('6.8.1');
  });
});

describe('cPanel API parsers', () => {
  it('parses whmapi1 listaccts', () => {
    const json = JSON.stringify({
      metadata: { result: 1, reason: 'OK' },
      data: {
        acct: [
          { user: 'examplea', domain: 'example.com', homedir: '/home/examplea', suspended: 0, email: 'x@example.com' },
          { user: 'exampleb', domain: 'example.org', suspended: 1 },
        ],
      },
    });
    expect(parseWhmListAccts('warning: something\n' + json)).toEqual([
      { user: 'examplea', domain: 'example.com', homedir: '/home/examplea', suspended: false },
      { user: 'exampleb', domain: 'example.org', homedir: undefined, suspended: true },
    ]);
  });

  it('throws on a failed whmapi1 call', () => {
    expect(() => parseWhmListAccts(JSON.stringify({ metadata: { result: 0, reason: 'Access denied' } }))).toThrow(
      /Access denied/,
    );
  });

  it('parses uapi domains_data, giving parked domains the main docroot', () => {
    const json = JSON.stringify({
      result: {
        status: 1,
        errors: null,
        data: {
          main_domain: { domain: 'example.com', documentroot: '/home/acct/public_html' },
          addon_domains: [{ domain: 'example.net', documentroot: '/home/acct/example.net' }],
          sub_domains: [{ domain: 'dev.example.com', documentroot: '/home/acct/dev' }],
          parked_domains: ['example.org'],
        },
      },
    });
    expect(parseUapiDomainsData(json)).toEqual([
      { domain: 'example.com', docroot: '/home/acct/public_html', type: 'main' },
      { domain: 'example.net', docroot: '/home/acct/example.net', type: 'addon' },
      { domain: 'dev.example.com', docroot: '/home/acct/dev', type: 'sub' },
      { domain: 'example.org', docroot: '/home/acct/public_html', type: 'parked' },
    ]);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseUapiDomainsData('Command not found')).toThrow(/no JSON/);
  });
});

describe('PathMatcher', () => {
  const m = new PathMatcher(excludePatterns());

  it('excludes LocalDock data, config and caches', () => {
    expect(m.excludes('.localdock/db.sql')).toBe(true);
    expect(m.excludes('wp-config.php')).toBe(true);
    expect(m.excludes('wp-content/cache/page/index.html')).toBe(true);
    expect(m.excludes('wp-content/themes/x/node_modules/a.js')).toBe(true);
    expect(m.excludes('wp-content/plugins/p/debug.log')).toBe(true);
    expect(m.excludes('wp-content/mu-plugins/localdock-mail.php')).toBe(true);
  });

  it('keeps ordinary site files', () => {
    expect(m.excludes('wp-content/themes/x/style.css')).toBe(false);
    expect(m.excludes('wp-content/themes/x/wp-config.php')).toBe(false);
    expect(m.excludes('index.php')).toBe(false);
  });

  it('excludes uploads but re-includes generated theme CSS, and still walks into uploads', () => {
    expect(m.excludes('wp-content/uploads/2026/10/photo.jpg')).toBe(true);
    expect(m.excludes('wp-content/uploads/astra/astra-theme-dynamic-css.css')).toBe(false);
    expect(m.excludes('wp-content/uploads', true)).toBe(false);
    expect(m.excludes('wp-content/uploads/2026', true)).toBe(true);
    expect(m.excludes('wp-content/cache', true)).toBe(true);
  });

  it('includes uploads when asked', () => {
    const all = new PathMatcher(excludePatterns({ includeUploads: true }));
    expect(all.excludes('wp-content/uploads/2026/10/photo.jpg')).toBe(false);
  });
});

describe('PathMatcher anchoring', () => {
  it('anchors patterns with a leading slash to the site root', () => {
    const m = new PathMatcher(['/wp-config.php', '*.log']);
    expect(m.excludes('wp-config.php')).toBe(true);
    expect(m.excludes('sub/wp-config.php')).toBe(false);
    expect(m.excludes('a/b/c.log')).toBe(true);
  });
});
