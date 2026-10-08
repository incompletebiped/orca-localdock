import { describe, it, expect } from 'vitest';
import { rewriteLineUrls, urlVariants, stripDatabaseStatements, appendSentinel, rewriteUrlsInDump } from '../src/db/sqlDump.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
const FROM = 'http://localhost:8080';
const TO = 'https://example.com';

describe('rewriteLineUrls', () => {
  it('returns line unchanged when from URL is not present', () => {
    const line = 'INSERT INTO wp_options VALUES (1, "siteurl", "https://example.com", "yes");';
    expect(rewriteLineUrls(line, FROM, TO)).toBe(line);
  });

  it('replaces plain-text URL occurrences', () => {
    const line = `INSERT INTO wp_options VALUES (1, 'siteurl', 'http://localhost:8080', 'yes');`;
    const result = rewriteLineUrls(line, FROM, TO);
    expect(result).toContain(TO);
    expect(result).not.toContain(FROM);
  });

  it('rewrites URLs inside PHP serialized strings and fixes byte count', () => {
    // s:22:"http://localhost:8080"; — 22 bytes for "http://localhost:8080"
    const from = 'http://localhost:8080';
    const to = 'https://example.com';
    const serialized = `s:${Buffer.byteLength(from, 'utf-8')}:"${from}";`;
    const result = rewriteLineUrls(serialized, from, to);
    const expectedLen = Buffer.byteLength(to, 'utf-8');
    expect(result).toBe(`s:${expectedLen}:"${to}";`);
  });

  it('handles serialized strings with embedded double quotes', () => {
    // Simulate a serialized string whose content contains a double quote char
    const content = `url("${FROM}/img.png")`;
    const byteLen = Buffer.byteLength(content, 'utf-8');
    const line = `s:${byteLen}:"${content}";`;
    const result = rewriteLineUrls(line, FROM, TO);
    const replaced = content.replace(new RegExp(FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), TO);
    const expectedLen = Buffer.byteLength(replaced, 'utf-8');
    expect(result).toBe(`s:${expectedLen}:"${replaced}";`);
  });

  it('handles multiple serialized tokens on a single line', () => {
    const s1 = `s:${Buffer.byteLength(FROM, 'utf-8')}:"${FROM}";`;
    const s2 = `s:${Buffer.byteLength(FROM, 'utf-8')}:"${FROM}";`;
    const line = `${s1} some text ${s2}`;
    const result = rewriteLineUrls(line, FROM, TO);
    expect(result.split(TO).length - 1).toBe(2);
    expect(result).not.toContain(FROM);
  });

  it('handles multi-byte (UTF-8) characters in serialized content', () => {
    const content = `${FROM}/café`;
    const byteLen = Buffer.byteLength(content, 'utf-8');
    const line = `s:${byteLen}:"${content}";`;
    const result = rewriteLineUrls(line, FROM, TO);
    const replaced = `${TO}/café`;
    const expectedLen = Buffer.byteLength(replaced, 'utf-8');
    expect(result).toBe(`s:${expectedLen}:"${replaced}";`);
  });

  it('skips malformed s:N:" tokens where N exceeds buffer length', () => {
    const line = 's:99999:"short";';
    // Should not throw and should return a usable string
    expect(() => rewriteLineUrls(line, FROM, TO)).not.toThrow();
  });
});

describe('urlVariants', () => {
  it('returns https and http forms without trailing slash', () => {
    expect(urlVariants('https://example.com/')).toEqual(['https://example.com', 'http://example.com']);
  });
});

describe('dump file transforms', () => {
  it('strips database statements, rewrites URLs and appends the sentinel', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-sql-'));
    const file = path.join(dir, 'db.sql');
    const serialized = `s:${'http://example.com/a'.length}:"http://example.com/a"`;
    await fs.writeFile(
      file,
      [
        'CREATE DATABASE `prod`;',
        'USE `prod`;',
        `INSERT INTO wp_options VALUES (1,'siteurl','https://example.com','yes');`,
        `INSERT INTO wp_options VALUES (2,'theme_mods','a:1:{s:3:"url";${serialized};}','yes');`,
      ].join('\n'),
    );
    await stripDatabaseStatements(file);
    await rewriteUrlsInDump(file, 'https://example.com', 'http://localhost:8080');
    await appendSentinel(file);
    const out = await fs.readFile(file, 'utf-8');
    expect(out).not.toMatch(/CREATE DATABASE|USE `prod`/);
    expect(out).toContain(`'siteurl','http://localhost:8080'`);
    const rewritten = 'http://localhost:8080/a';
    expect(out).toContain(`s:${rewritten.length}:"${rewritten}"`);
    expect(out).toContain('_localdock_ready');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
