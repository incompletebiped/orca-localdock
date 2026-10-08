/**
 * Minimal gitignore-style matcher for site-relative paths (forward slashes).
 *
 * - `*` matches within one path segment, `**` matches across segments.
 * - A pattern without a `/` matches the file name in any directory (`*.log`).
 * - `dir/**` matches everything under `dir`.
 * - Patterns starting with `!` re-include paths, and win over exclusions.
 *   Parent directories of re-included paths are never excluded, so a walker
 *   can still reach them.
 */
export class PathMatcher {
  private readonly include: RegExp[] = [];
  private readonly reinclude: RegExp[] = [];
  private readonly reincludePrefixes: string[] = [];

  constructor(patterns: readonly string[]) {
    for (const raw of patterns) {
      const pattern = raw.trim();
      if (!pattern || pattern.startsWith('#')) {
        continue;
      }
      if (pattern.startsWith('!')) {
        const body = pattern.slice(1);
        this.reinclude.push(globToRegExp(body));
        const literalPrefix = body.split(/[*?[]/)[0]!.replace(/\/+$/, '');
        if (literalPrefix) {
          this.reincludePrefixes.push(literalPrefix);
        }
      } else {
        this.include.push(globToRegExp(pattern));
      }
    }
  }

  /** True when `relPath` should be skipped. Pass `isDirectory` for directories. */
  excludes(relPath: string, isDirectory = false): boolean {
    if (this.reinclude.some((re) => re.test(relPath))) {
      return false;
    }
    if (isDirectory && this.reincludePrefixes.some((p) => p === relPath || p.startsWith(relPath + '/'))) {
      return false;
    }
    // For directories also test "dir/", so `dir/**` prunes the directory itself
    // instead of walking it and excluding every child.
    return this.include.some((re) => re.test(relPath) || (isDirectory && re.test(relPath + '/')));
  }
}

export function globToRegExp(glob: string): RegExp {
  const anchored = glob.includes('/');
  const body = glob.replace(/^\/+/, '');
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '*') {
      if (body[i + 1] === '*') {
        // `**/` matches zero or more directories; a trailing `**` matches everything below.
        if (body[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`);
}
