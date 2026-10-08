import { describe, it, expect } from 'vitest';
import {
  type DedupCandidate,
  conflictingDomains,
  dedupeByDocroot,
  normalizeDocroot,
  registrableHost,
} from '../src/discovery/docrootDedup.js';

const c = (domain: string, docroot: string, type: DedupCandidate['type'] = 'addon'): DedupCandidate => ({
  domain,
  docroot,
  type,
});

describe('normalizeDocroot', () => {
  it('strips trailing slashes and lowercases', () => {
    expect(normalizeDocroot('/home/User/public_html/')).toBe('/home/user/public_html');
    expect(normalizeDocroot('/home/user/site')).toBe('/home/user/site');
  });
});

describe('registrableHost', () => {
  it('ignores leading www and case', () => {
    expect(registrableHost('WWW.Example.com')).toBe('example.com');
    expect(registrableHost('example.com')).toBe('example.com');
  });
});

describe('conflictingDomains', () => {
  it('returns only domains that share a docroot with another', () => {
    const cands = [
      c('a.com', '/home/u/public_html/shared'),
      c('b.com', '/home/u/public_html/shared'),
      c('solo.com', '/home/u/public_html/solo'),
    ];
    expect(conflictingDomains(cands).sort()).toEqual(['a.com', 'b.com']);
  });

  it('treats trailing-slash / case variants as the same docroot', () => {
    const cands = [
      c('a.com', '/home/u/Shared/'),
      c('b.com', '/home/u/shared'),
    ];
    expect(conflictingDomains(cands).sort()).toEqual(['a.com', 'b.com']);
  });
});

describe('dedupeByDocroot', () => {
  it('keeps every domain when none share a docroot', () => {
    const cands = [
      c('a.com', '/home/u/a'),
      c('b.com', '/home/u/b'),
    ];
    expect(dedupeByDocroot(cands, new Map())).toEqual(new Set(['a.com', 'b.com']));
  });

  it('drops the redirecting domain in a shared docroot (the reported bug)', () => {
    // example-mail.com is pointed at example-shop.com's folder for email;
    // it redirects off-host, so the shop site should win.
    const cands = [
      c('example-mail.com', '/home/u/public_html/example-shop.com'),
      c('example-shop.com', '/home/u/public_html/example-shop.com'),
    ];
    const hosts = new Map<string, string | null>([
      ['example-mail.com', 'example-shop.com'],
      ['example-shop.com', 'example-shop.com'],
    ]);
    expect(dedupeByDocroot(cands, hosts)).toEqual(new Set(['example-shop.com']));
  });

  it('prefers the self-serving domain even without folder-name hints', () => {
    const cands = [
      c('alias.com', '/home/u/public_html'),
      c('real.com', '/home/u/public_html'),
    ];
    const hosts = new Map<string, string | null>([
      ['alias.com', 'real.com'],
      ['real.com', 'real.com'],
    ]);
    expect(dedupeByDocroot(cands, hosts)).toEqual(new Set(['real.com']));
  });

  it('falls back to folder-name match when the probe is inconclusive', () => {
    const cands = [
      c('example-mail.com', '/home/u/public_html/example-shop.com'),
      c('example-shop.com', '/home/u/public_html/example-shop.com'),
    ];
    // Both probes failed (null) — the folder is named after the games domain.
    const hosts = new Map<string, string | null>([
      ['example-mail.com', null],
      ['example-shop.com', null],
    ]);
    expect(dedupeByDocroot(cands, hosts)).toEqual(new Set(['example-shop.com']));
  });

  it('prefers the main domain over an addon on a tie', () => {
    const cands = [
      c('addon.com', '/home/u/public_html', 'addon'),
      c('main.com', '/home/u/public_html', 'main'),
    ];
    expect(dedupeByDocroot(cands, new Map())).toEqual(new Set(['main.com']));
  });

  it('never hides a site when all probes fail and there is no other signal', () => {
    // Two equally-ranked domains, both probes inconclusive: still collapses to
    // exactly one (same docroot = same install) and is deterministic.
    const cands = [
      c('bbb.com', '/home/u/public_html', 'addon'),
      c('aaa.com', '/home/u/public_html', 'addon'),
    ];
    const kept = dedupeByDocroot(cands, new Map());
    expect(kept.size).toBe(1);
  });
});
