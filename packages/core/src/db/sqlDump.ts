import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite every occurrence of `from` with `to` in one line of a SQL dump.
 *
 * PHP serialized strings are written `s:N:"<content>"`, where N is the content's
 * length in bytes. A naive regex stops at the first embedded double quote, gets
 * the length wrong and corrupts the whole value, so unserialize() fails and the
 * option (for example every customizer setting) silently resets. Instead, each
 * `s:N:"` marker is located, exactly N bytes are read, URLs inside are rewritten
 * and the byte length is recomputed. Remaining plain-text occurrences (JSON,
 * ordinary columns) are then replaced directly.
 */
export function rewriteLineUrls(line: string, from: string, to: string): string {
  if (!line.includes(from)) {
    return line;
  }

  const fromRe = new RegExp(escapeRegExp(from), 'g');
  const lineBuf = Buffer.from(line, 'utf-8');

  let result = '';
  let charPos = 0;
  const sPattern = /s:(\d+):"/g;
  let m: RegExpExecArray | null;

  while ((m = sPattern.exec(line)) !== null) {
    const matchCharStart = m.index;
    const byteLen = parseInt(m[1]!, 10);
    const contentCharStart = matchCharStart + m[0].length;
    const byteContentStart = Buffer.byteLength(line.slice(0, contentCharStart), 'utf-8');

    // A malformed s:N:" whose N runs past the end of the line.
    if (byteContentStart + byteLen > lineBuf.length) {
      continue;
    }

    const content = lineBuf.subarray(byteContentStart, byteContentStart + byteLen).toString('utf-8');

    // The closing quote must sit immediately after the declared byte span.
    const closingCharPos = contentCharStart + content.length;
    if (line[closingCharPos] !== '"') {
      continue;
    }

    result += line.slice(charPos, matchCharStart);
    if (content.includes(from)) {
      const replaced = content.replace(fromRe, to);
      result += `s:${Buffer.byteLength(replaced, 'utf-8')}:"${replaced}"`;
    } else {
      result += `s:${byteLen}:"${content}"`;
    }

    charPos = closingCharPos + 1;
    sPattern.lastIndex = charPos;
  }

  result += line.slice(charPos);
  if (result.includes(from)) {
    result = result.replace(fromRe, to);
  }
  return result;
}

/** Stream a dump through `transform` line by line, replacing the file in place. */
async function transformDump(sqlPath: string, transform: (line: string) => string | null): Promise<void> {
  const tmpPath = sqlPath + '.tmp';
  const input = fs.createReadStream(sqlPath, { encoding: 'utf-8' });
  const output = fs.createWriteStream(tmpPath, { encoding: 'utf-8', mode: 0o600 });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const out = transform(line);
      if (out !== null && !output.write(out + '\n')) {
        await new Promise<void>((resolve) => output.once('drain', resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject);
      output.end(resolve);
    });
  } catch (err) {
    output.destroy();
    await fsp.rm(tmpPath, { force: true });
    throw err;
  }
  await fsp.rename(tmpPath, sqlPath);
}

/** Rewrite one site URL to another throughout a dump file (http and https variants of `from`). */
export async function rewriteUrlsInDump(sqlPath: string, fromUrl: string, toUrl: string): Promise<void> {
  const to = toUrl.replace(/\/$/, '');
  const froms = urlVariants(fromUrl).filter((f) => f !== to);
  if (froms.length === 0) {
    return;
  }
  await transformDump(sqlPath, (line) => froms.reduce((acc, from) => rewriteLineUrls(acc, from, to), line));
}

/** `https://example.com` → [`https://example.com`, `http://example.com`]. */
export function urlVariants(url: string): string[] {
  const base = url.replace(/\/$/, '');
  const other = base.startsWith('https://')
    ? 'http://' + base.slice('https://'.length)
    : base.startsWith('http://')
      ? 'https://' + base.slice('http://'.length)
      : base;
  return [...new Set([base, other])];
}

/**
 * Strip CREATE DATABASE, DROP DATABASE and USE statements so a dump imports
 * into whichever database is already selected (the Docker default).
 */
export async function stripDatabaseStatements(sqlPath: string): Promise<void> {
  await transformDump(sqlPath, (line) => {
    const t = line.trimStart();
    if (/^CREATE\s+DATABASE\b/i.test(t) || /^DROP\s+DATABASE\b/i.test(t) || /^USE\s+`[^`]+`\s*;/i.test(t)) {
      return null;
    }
    return line;
  });
}

export const READY_SENTINEL_TABLE = '_localdock_ready';

/**
 * Append a sentinel table to the end of a dump. The Docker healthcheck waits
 * for it, so WordPress doesn't boot against a half-imported database.
 */
export async function appendSentinel(sqlPath: string): Promise<void> {
  const sentinel =
    '\n-- LocalDock initialization sentinel (do not remove)\n' +
    `CREATE TABLE IF NOT EXISTS \`${READY_SENTINEL_TABLE}\` (\`id\` tinyint(1) NOT NULL DEFAULT '1');\n` +
    `INSERT IGNORE INTO \`${READY_SENTINEL_TABLE}\` (\`id\`) VALUES (1);\n`;
  await fsp.appendFile(sqlPath, sentinel, 'utf-8');
}
