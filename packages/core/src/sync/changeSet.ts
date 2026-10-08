/**
 * Three-way comparison of the sync baseline against the local folder and the
 * live server. Pure: callers resolve content hashes for both sides first.
 */

export type SideChange = 'unchanged' | 'added' | 'modified' | 'deleted';

/**
 * - `push`: changed locally only, so it can be uploaded.
 * - `pull`: changed on the server only, so it can be downloaded.
 * - `conflict`: changed differently on both sides.
 * - `same`: changed on both sides, but identically (both deleted, or the same edit).
 */
export type Direction = 'push' | 'pull' | 'conflict' | 'same';

export interface ChangeEntry {
  path: string;
  local: SideChange;
  remote: SideChange;
  direction: Direction;
}

/** Content hash per site-relative path. A missing key means the file doesn't exist on that side. */
export type HashMap = ReadonlyMap<string, string>;

export function sideChange(base: string | undefined, current: string | undefined): SideChange {
  if (base === undefined) return current === undefined ? 'unchanged' : 'added';
  if (current === undefined) return 'deleted';
  return base === current ? 'unchanged' : 'modified';
}

export function computeChangeSet(baseline: HashMap, local: HashMap, remote: HashMap): ChangeEntry[] {
  const paths = new Set<string>([...baseline.keys(), ...local.keys(), ...remote.keys()]);
  const entries: ChangeEntry[] = [];
  for (const p of paths) {
    const base = baseline.get(p);
    const l = local.get(p);
    const r = remote.get(p);
    const localChange = sideChange(base, l);
    const remoteChange = sideChange(base, r);
    if (localChange === 'unchanged' && remoteChange === 'unchanged') {
      continue;
    }
    let direction: Direction;
    if (remoteChange === 'unchanged') direction = 'push';
    else if (localChange === 'unchanged') direction = 'pull';
    else direction = l === r ? 'same' : 'conflict';
    entries.push({ path: p, local: localChange, remote: remoteChange, direction });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export interface ChangeSummary {
  push: number;
  pull: number;
  conflict: number;
  same: number;
}

export function summarize(entries: readonly ChangeEntry[]): ChangeSummary {
  const s: ChangeSummary = { push: 0, pull: 0, conflict: 0, same: 0 };
  for (const e of entries) s[e.direction]++;
  return s;
}
