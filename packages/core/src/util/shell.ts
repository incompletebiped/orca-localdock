import { LocalDockError } from '../errors.js';

/**
 * Quote a value for a POSIX shell. The result is always a single
 * single-quoted word, so no character in `value` can be interpreted by the
 * shell. Use this for every value that goes into a remote command.
 */
export function shq(value: string): string {
  if (value.includes('\0')) {
    throw new LocalDockError('Refusing to quote a value containing a NUL byte', 'UNSAFE_INPUT', false);
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build a command line from argv, quoting every argument. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map(shq).join(' ');
}

/** cPanel account usernames: lowercase letters/digits, starting with a letter, at most 16 chars. */
const CPANEL_USER_RE = /^[a-z][a-z0-9]{0,15}$/;
/** Hostnames as they appear in cPanel domain lists (no wildcards, no trailing dot). */
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
/** MySQL database, user and table names as cPanel creates them. */
const DB_IDENTIFIER_RE = /^[A-Za-z0-9_]{1,64}$/;
/** DB_HOST values: a hostname, IPv4 or bracketed IPv6, with an optional port, or a socket path. */
const DB_HOST_RE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;
const DB_SOCKET_RE = /^[A-Za-z0-9.-]*:\/[A-Za-z0-9_./-]+$/;

export function isValidCpanelUser(value: string): boolean {
  return CPANEL_USER_RE.test(value);
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_RE.test(value);
}

export function isValidDbIdentifier(value: string): boolean {
  return DB_IDENTIFIER_RE.test(value);
}

export function isValidDbHost(value: string): boolean {
  return DB_HOST_RE.test(value) || DB_SOCKET_RE.test(value);
}

export function assertValid(kind: string, value: string, valid: (v: string) => boolean): string {
  if (!valid(value)) {
    throw new LocalDockError(`Invalid ${kind}: ${JSON.stringify(value)}`, 'UNSAFE_INPUT', false);
  }
  return value;
}

/** Turn a domain into a name usable for Docker projects, volumes and local folders. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug || 'site';
}
