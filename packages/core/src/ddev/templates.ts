import { randomBytes } from 'node:crypto';

/**
 * The local wp-config.php. Production's wp-config.php is never downloaded:
 * it holds live credentials and salts that have no business on a laptop.
 * This file only carries the production table prefix and loads DDEV's
 * generated database settings (wp-config-ddev.php).
 */
export function localWpConfig(tablePrefix: string): string {
  const salt = () => randomBytes(48).toString('base64');
  const keys = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
  return `<?php
/**
 * Local configuration written by LocalDock. Never pushed to the server:
 * the live site keeps its own wp-config.php.
 */

$table_prefix = '${tablePrefix}';

${keys.map((k) => `define( '${k}', '${salt()}' );`).join('\n')}

define( 'WP_ENVIRONMENT_TYPE', 'local' );
// Scheduled jobs could otherwise contact live services (payment gateways, mailing lists, …).
define( 'DISABLE_WP_CRON', true );

// Database, URLs and debug settings managed by DDEV.
if ( getenv( 'IS_DDEV_PROJECT' ) === 'true' && is_readable( __DIR__ . '/wp-config-ddev.php' ) ) {
	require_once __DIR__ . '/wp-config-ddev.php';
}

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`;
}

/** wp-content/uploads/.htaccess: serve media that wasn't pulled from the live site. */
export function uploadsProxyHtaccess(productionUrl: string): string {
  const base = productionUrl.replace(/\/$/, '');
  return `# Written by LocalDock (local only, never pushed).
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^(.*)$ ${base}/wp-content/uploads/$1 [R=302,L]
</IfModule>
`;
}

export const DEV_MU_PLUGIN = `<?php
/**
 * LocalDock: local development helpers. Written by LocalDock (local only, never pushed).
 */

// Page-cache and asset-optimization plugins hide edits locally; switch them off.
add_filter( 'option_active_plugins', function ( $plugins ) {
	$disable = array(
		'hummingbird-performance/hummingbird-performance.php',
		'wp-hummingbird/wp-hummingbird.php',
		'litespeed-cache/litespeed-cache.php',
		'wp-rocket/wp-rocket.php',
		'w3-total-cache/w3-total-cache.php',
		'wp-super-cache/wp-cache.php',
		'wp-fastest-cache/wpFastestCache.php',
		'autoptimize/autoptimize.php',
		'sg-cachepress/sg-cachepress.php',
		'breeze/breeze.php',
		'cache-enabler/cache-enabler.php',
		'comet-cache/comet-cache.php',
	);
	return array_values( array_diff( (array) $plugins, $disable ) );
} );

// Keep the local copy out of search engines.
add_filter( 'pre_option_blog_public', '__return_zero' );
`;

/** Drop HTTPS and canonical-host redirects from the root .htaccess; they break the local URL. */
export function sanitizeHtaccess(content: string): string {
  return content
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^RewriteCond\s+%\{HTTPS\}\s+(off|!on)/i.test(t)) return false;
      if (/^RewriteCond\s+%\{SERVER_PORT\}/i.test(t)) return false;
      if (/^RewriteCond\s+%\{HTTP_HOST\}\s+!/i.test(t)) return false;
      if (/^RewriteCond\s+%\{HTTP:X-Forwarded-Proto\}/i.test(t)) return false;
      if (/^RewriteRule\s+\S+\s+https?:\/\/\S+\s+\[[^\]]*R(=\d+)?[^\]]*\]/i.test(t)) return false;
      if (/^Header\s+(always\s+)?set\s+Strict-Transport-Security/i.test(t)) return false;
      return true;
    })
    .join('\n');
}
