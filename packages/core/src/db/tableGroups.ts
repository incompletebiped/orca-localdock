/**
 * Table groups for selective database push. Pulling always takes everything;
 * pushing only sends the groups the user picks, so live-only data (orders,
 * form entries, comments, users) isn't overwritten by accident.
 */
export type TableGroup = 'content' | 'config' | 'users' | 'comments' | 'commerce' | 'plugins' | 'other';

export const TABLE_GROUPS: Record<TableGroup, { label: string; description: string; pushByDefault: boolean }> = {
  content: {
    label: 'Content',
    description: 'Posts, pages, custom post types, menus, categories and tags',
    pushByDefault: true,
  },
  config: {
    label: 'Settings',
    description: 'Site options, theme and plugin settings (wp_options)',
    pushByDefault: true,
  },
  users: { label: 'Users', description: 'User accounts and profiles', pushByDefault: false },
  comments: { label: 'Comments', description: 'Comments and their metadata', pushByDefault: false },
  commerce: {
    label: 'Store & forms',
    description: 'WooCommerce orders and customers, form entries, scheduled actions',
    pushByDefault: false,
  },
  plugins: { label: 'Other plugin tables', description: 'Tables created by plugins', pushByDefault: false },
  other: { label: 'Non-WordPress tables', description: 'Tables without the WordPress prefix', pushByDefault: false },
};

const CORE: Record<string, TableGroup> = {
  posts: 'content',
  postmeta: 'content',
  terms: 'content',
  termmeta: 'content',
  term_taxonomy: 'content',
  term_relationships: 'content',
  links: 'content',
  options: 'config',
  users: 'users',
  usermeta: 'users',
  comments: 'comments',
  commentmeta: 'comments',
};

const COMMERCE_PREFIXES = [
  'woocommerce_',
  'wc_',
  'actionscheduler_',
  'gf_',
  'rg_',
  'frm_',
  'wpforms_',
  'e_submissions',
  'fluentform_',
  'edd_',
];

export function tableGroup(table: string, prefix: string): TableGroup {
  if (!table.startsWith(prefix)) return 'other';
  const rest = table.slice(prefix.length);
  const core = CORE[rest];
  if (core) return core;
  if (COMMERCE_PREFIXES.some((p) => rest.startsWith(p))) return 'commerce';
  return 'plugins';
}

export function groupTables(tables: readonly string[], prefix: string): Record<TableGroup, string[]> {
  const out: Record<TableGroup, string[]> = {
    content: [],
    config: [],
    users: [],
    comments: [],
    commerce: [],
    plugins: [],
    other: [],
  };
  for (const t of tables) out[tableGroup(t, prefix)].push(t);
  return out;
}

export function defaultPushGroups(): TableGroup[] {
  return (Object.keys(TABLE_GROUPS) as TableGroup[]).filter((g) => TABLE_GROUPS[g].pushByDefault);
}
