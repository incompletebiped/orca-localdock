/**
 * What a site file belongs to, for treating updates as a whole: WordPress
 * core, one plugin, one theme, or nothing in particular (null). Pulling half
 * of a plugin or core update leaves the local site running mismatched code.
 */
export function updateGroup(path: string): string | null {
  const parts = path.split('/');
  if (parts[0] === 'wp-admin' || parts[0] === 'wp-includes') return 'WordPress core';
  if (parts.length === 1 && /^(wp-[\w-]+|xmlrpc|index)\.php$/.test(parts[0]!) && parts[0] !== 'wp-config.php') return 'WordPress core';
  if (parts[0] === 'wp-content' && parts.length > 3) {
    if (parts[1] === 'plugins' || parts[1] === 'mu-plugins') return `${parts[1] === 'plugins' ? 'plugin' : 'must-use plugin'} ${parts[2]}`;
    if (parts[1] === 'themes') return `theme ${parts[2]}`;
  }
  return null;
}

export interface PartialGroup {
  group: string;
  selected: number;
  total: number;
}

/**
 * The update groups a selection only partly covers: groups with changes in
 * `all` of which only some are in `selected`.
 */
export function partialGroups(selected: readonly string[], all: readonly string[]): PartialGroup[] {
  const totals = new Map<string, number>();
  for (const p of all) {
    const g = updateGroup(p);
    if (g) totals.set(g, (totals.get(g) ?? 0) + 1);
  }
  const chosen = new Map<string, number>();
  for (const p of selected) {
    const g = updateGroup(p);
    if (g) chosen.set(g, (chosen.get(g) ?? 0) + 1);
  }
  return [...chosen]
    .map(([group, n]) => ({ group, selected: n, total: totals.get(group) ?? n }))
    .filter((g) => g.selected < g.total);
}
