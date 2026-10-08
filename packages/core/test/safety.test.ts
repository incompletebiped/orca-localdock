import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { shq, shellCommand, isValidCpanelUser, isValidDomain, isValidDbHost, isValidDbIdentifier, slugify } from '../src/util/shell.js';
import { assertSafeRemoteDir, normalizeRelPath, remoteJoin, localJoin } from '../src/util/remotePath.js';
import { redact, registerSecret, createLogger, type LogEntry } from '../src/log.js';

describe('shq', () => {
  it('single-quotes values so the shell treats them literally', () => {
    expect(shq('plain')).toBe(`'plain'`);
    expect(shq(`it's`)).toBe(`'it'\\''s'`);
    expect(shq('$(rm -rf /); `id` && echo')).toBe(`'$(rm -rf /); \`id\` && echo'`);
  });
  it('rejects NUL bytes', () => {
    expect(() => shq('a\0b')).toThrow();
  });
  it('builds argv command lines', () => {
    expect(shellCommand(['uapi', '--user=bob', 'DomainInfo'])).toBe(`'uapi' '--user=bob' 'DomainInfo'`);
  });
});

describe('validators', () => {
  it('accepts cPanel usernames and rejects injection attempts', () => {
    expect(isValidCpanelUser('examplec')).toBe(true);
    expect(isValidCpanelUser('Bob')).toBe(false);
    expect(isValidCpanelUser('bob;id')).toBe(false);
    expect(isValidCpanelUser('a'.repeat(17))).toBe(false);
  });
  it('accepts domains', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('dev.sub.example.co.uk')).toBe(true);
    expect(isValidDomain('example')).toBe(false);
    expect(isValidDomain('ex ample.com')).toBe(false);
    expect(isValidDomain('-bad.example.com')).toBe(false);
  });
  it('accepts DB hosts and identifiers', () => {
    expect(isValidDbHost('localhost')).toBe(true);
    expect(isValidDbHost('localhost:3307')).toBe(true);
    expect(isValidDbHost('[::1]:3306')).toBe(true);
    expect(isValidDbHost('localhost:/var/lib/mysql/mysql.sock')).toBe(true);
    expect(isValidDbHost('localhost; rm -rf /')).toBe(false);
    expect(isValidDbIdentifier('acct_wp123')).toBe(true);
    expect(isValidDbIdentifier('wp`; DROP')).toBe(false);
  });
  it('slugifies', () => {
    expect(slugify('www.Example.com')).toBe('www-example-com');
    expect(slugify('!!!')).toBe('site');
  });
});

describe('remote path guard', () => {
  it('accepts normal docroots and strips trailing slashes', () => {
    expect(assertSafeRemoteDir('/home/acct/public_html/')).toBe('/home/acct/public_html');
  });
  it('rejects traversal, relative paths and odd characters', () => {
    expect(() => assertSafeRemoteDir('/home/acct/../root')).toThrow();
    expect(() => assertSafeRemoteDir('home/acct')).toThrow();
    expect(() => assertSafeRemoteDir('/home/acct/$(id)')).toThrow();
  });
  it('normalizes relative paths and blocks escapes', () => {
    expect(normalizeRelPath('wp-content\\themes\\x\\style.css')).toBe('wp-content/themes/x/style.css');
    expect(normalizeRelPath('a/./b//c')).toBe('a/b/c');
    expect(() => normalizeRelPath('../etc/passwd')).toThrow();
    expect(() => normalizeRelPath('a/../../b')).toThrow();
    expect(() => normalizeRelPath('/etc/passwd')).toThrow();
    expect(() => normalizeRelPath('C:/Windows')).toThrow();
    expect(() => normalizeRelPath('')).toThrow();
  });
  it('joins inside the root', () => {
    expect(remoteJoin('/home/acct/public_html', 'wp-content/x.php')).toBe('/home/acct/public_html/wp-content/x.php');
    expect(() => remoteJoin('/home/acct/public_html', 'a/../../x')).toThrow();
    const root = path.resolve('site');
    expect(localJoin(root, 'wp-content/x.php')).toBe(path.join(root, 'wp-content', 'x.php'));
    expect(() => localJoin(root, '../outside')).toThrow();
  });
});

describe('log redaction', () => {
  it('masks common secret shapes', () => {
    expect(redact(`MYSQL_PWD='hunter22' mysqldump`)).toBe(`MYSQL_PWD=*** mysqldump`);
    expect(redact(`[client]\npassword=s3cr3t!`)).toContain('password=***');
    expect(redact(`define( 'DB_PASSWORD', 'p@ss' );`)).toBe(`define( 'DB_PASSWORD', '***' );`);
    expect(redact(`define('AUTH_KEY', 'abc');`)).toBe(`define('AUTH_KEY', '***');`);
    expect(redact('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----')).toBe('[private key]');
  });
  it('masks registered secrets anywhere in a message', () => {
    registerSecret('correct-horse-battery');
    const entries: LogEntry[] = [];
    createLogger((e) => entries.push(e)).child('test').info('failed with correct-horse-battery in output');
    expect(entries[0]!.message).toBe('failed with *** in output');
    expect(entries[0]!.scope).toBe('localdock:test');
  });
});
