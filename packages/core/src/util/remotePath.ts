import * as path from 'node:path';
import { LocalDockError } from '../errors.js';

/** Characters allowed in absolute remote directories we operate on (docroots, home dirs). */
const SAFE_ABS_DIR_RE = /^\/[A-Za-z0-9_.\-/]*$/;

/**
 * Validate an absolute remote directory such as a docroot. Rejects relative
 * paths, `..` segments and characters outside a conservative set, and
 * returns the path without trailing slashes.
 */
export function assertSafeRemoteDir(dir: string): string {
  const trimmed = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  if (!SAFE_ABS_DIR_RE.test(trimmed) || trimmed.split('/').some((s) => s === '..' || s === '.')) {
    throw new LocalDockError(`Unsafe remote directory: ${JSON.stringify(dir)}`, 'UNSAFE_INPUT', false);
  }
  return trimmed;
}

/**
 * Normalize a site-relative path (as used in change sets and sync state) to
 * forward slashes. Throws if the path is absolute, empty, or would escape the
 * site root once resolved.
 */
export function normalizeRelPath(relPath: string): string {
  if (relPath.includes('\0')) {
    throw new LocalDockError('Path contains a NUL byte', 'UNSAFE_INPUT', false);
  }
  const forward = relPath.replace(/\\/g, '/');
  if (forward.startsWith('/') || /^[A-Za-z]:/.test(forward)) {
    throw new LocalDockError(`Expected a relative path, got ${JSON.stringify(relPath)}`, 'UNSAFE_INPUT', false);
  }
  const normalized = path.posix.normalize(forward).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new LocalDockError(`Path escapes the site root: ${JSON.stringify(relPath)}`, 'UNSAFE_INPUT', false);
  }
  return normalized;
}

/** Join a site-relative path onto a remote docroot, guaranteeing the result stays inside it. */
export function remoteJoin(docroot: string, relPath: string): string {
  const root = assertSafeRemoteDir(docroot);
  const rel = normalizeRelPath(relPath);
  return root === '/' ? `/${rel}` : `${root}/${rel}`;
}

/** Join a site-relative path onto a local site folder, guaranteeing the result stays inside it. */
export function localJoin(siteDir: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  const root = path.resolve(siteDir);
  const full = path.resolve(root, ...rel.split('/'));
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new LocalDockError(`Path escapes the site folder: ${JSON.stringify(relPath)}`, 'UNSAFE_INPUT', false);
  }
  return full;
}

/** Parent directory of a remote POSIX path. */
export function remoteDirname(p: string): string {
  return path.posix.dirname(p);
}
