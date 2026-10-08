export interface WpConfigValues {
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  /** DB_HOST as written, e.g. `localhost`, `localhost:3307` or `localhost:/tmp/mysql.sock`. */
  dbHost?: string;
  tablePrefix?: string;
  /** Constants that are defined with something other than a string literal (getenv(), variables, …). */
  nonLiteral: string[];
}

const WANTED: Record<string, keyof Omit<WpConfigValues, 'nonLiteral' | 'tablePrefix'>> = {
  DB_NAME: 'dbName',
  DB_USER: 'dbUser',
  DB_PASSWORD: 'dbPassword',
  DB_HOST: 'dbHost',
};

/**
 * Remove PHP comments while leaving string literals intact, so commented-out
 * `define()` lines are ignored and a `//` inside a password isn't treated as
 * a comment.
 */
export function stripPhpComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "'" || ch === '"') {
      const end = findStringEnd(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if ((ch === '/' && next === '/') || ch === '#') {
      // A line comment runs to the end of the line, or to a closing `?>`.
      let j = i;
      while (j < src.length && src[j] !== '\n' && !(src[j] === '?' && src[j + 1] === '>')) {
        j++;
      }
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function findStringEnd(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return src.length;
}

/** Decode a PHP string literal including its quotes. Returns undefined for double-quoted strings with interpolation. */
export function decodePhpString(literal: string): string | undefined {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === "'") {
    return body.replace(/\\(['\\])/g, '$1');
  }
  if (/(^|[^\\])\$[A-Za-z_{]/.test(body)) {
    return undefined;
  }
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', v: '\v', e: '\x1b', f: '\f', '\\': '\\', $: '$', '"': '"' };
  return body.replace(/\\([ntrvef\\$"])/g, (_, c: string) => escapes[c]!);
}

const STRING_RE = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const DEFINE_RE = new RegExp(
  String.raw`define\s*\(\s*(['"])(DB_NAME|DB_USER|DB_PASSWORD|DB_HOST)\1\s*,\s*(${STRING_RE}|[^)]*)\s*(?:,\s*[^)]*)?\)`,
  'g',
);
const PREFIX_RE = new RegExp(String.raw`\$table_prefix\s*=\s*${STRING_RE}\s*;`);

/** Parse the database settings out of a wp-config.php source. Never evaluates PHP. */
export function parseWpConfig(source: string): WpConfigValues {
  const code = stripPhpComments(source);
  const result: WpConfigValues = { nonLiteral: [] };
  for (const m of code.matchAll(DEFINE_RE)) {
    const name = m[2]!;
    const raw = m[3]!.trim();
    const key = WANTED[name]!;
    const value = /^['"]/.test(raw) ? decodePhpString(raw) : undefined;
    if (value === undefined) {
      result.nonLiteral.push(name);
    } else if (result[key] === undefined) {
      // PHP ignores redefinitions of a constant, so the first define wins.
      result[key] = value;
    }
  }
  const prefix = code.match(PREFIX_RE);
  if (prefix) {
    result.tablePrefix = decodePhpString(prefix[1]!);
  }
  return result;
}

/** Extract `$wp_version` from wp-includes/version.php. */
export function parseWpVersion(source: string): string | undefined {
  const m = stripPhpComments(source).match(new RegExp(String.raw`\$wp_version\s*=\s*${STRING_RE}\s*;`));
  return m ? decodePhpString(m[1]!) : undefined;
}
