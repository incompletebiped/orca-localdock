/**
 * Paths never synced in either direction. Patterns follow PathMatcher syntax.
 */
export const ALWAYS_EXCLUDED: readonly string[] = [
  // LocalDock's own data (database dumps, sync state) and DDEV's project config.
  '.localdock/**',
  '.ddev/**',
  '/wp-config-ddev.php',
  // Project metadata that isn't part of the site.
  '/.git/**',
  '/.orca/**',
  '/.gitignore',
  // Environment-specific config at the site root (a leading / anchors a pattern to the root):
  // patched for Docker locally, so it must never overwrite production.
  '/wp-config.php',
  '/.htaccess',
  '/.user.ini',
  '/php.ini',
  // Files LocalDock writes for the local environment only.
  'wp-content/uploads/.htaccess',
  'wp-content/mu-plugins/localdock-*.php',
  // Drop-ins tied to production infrastructure (Redis/Memcached, custom DB).
  'wp-content/object-cache.php',
  'wp-content/db.php',
  'wp-content/advanced-cache.php',
  // Caches, logs, backups, VCS and OS cruft.
  'wp-content/cache/**',
  'wp-content/upgrade/**',
  'wp-content/backup-db/**',
  'wp-content/updraft/**',
  'wp-content/ai1wm-backups/**',
  'wp-content/debug.log',
  'error_log',
  '*.log',
  '**/.git/**',
  '**/node_modules/**',
  '.DS_Store',
  'Thumbs.db',
  // cPanel/hosting files that live in the docroot.
  '.well-known/**',
  'cgi-bin/**',
];

/** Media is large, so it isn't synced by default (missing local media is proxied to the live site). */
export const UPLOADS_EXCLUDED: readonly string[] = ['wp-content/uploads/**'];

/**
 * Generated assets inside uploads that themes/builders need locally even when
 * media isn't synced (otherwise pages render unstyled).
 */
export const UPLOADS_ALWAYS_SYNCED: readonly string[] = [
  '!wp-content/uploads/uag-plugin/**',
  '!wp-content/uploads/elementor/css/**',
  '!wp-content/uploads/elementor/fonts/**',
  '!wp-content/uploads/astra/**',
  '!wp-content/uploads/oceanwp/**',
  '!wp-content/uploads/generatepress/**',
  '!wp-content/uploads/bb-plugin/**',
  '!wp-content/uploads/fusion-styles/**',
];

export interface ExcludeOptions {
  /** Sync wp-content/uploads too. */
  includeUploads?: boolean;
  /** Extra user patterns (gitignore-style; `!pattern` re-includes). */
  extra?: readonly string[];
}

export function excludePatterns(options: ExcludeOptions = {}): string[] {
  return [
    ...ALWAYS_EXCLUDED,
    ...(options.includeUploads ? [] : [...UPLOADS_EXCLUDED, ...UPLOADS_ALWAYS_SYNCED]),
    ...(options.extra ?? []),
  ];
}
