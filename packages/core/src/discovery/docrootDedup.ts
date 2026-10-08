import type { DomainEntry } from './cpanelApi.js';

/**
 * A domain that passed WordPress detection and is a candidate for the sites list.
 * Multiple domains can share one docroot (e.g. an email-only domain pointed at
 * another site's folder in cPanel), in which case they resolve to the *same*
 * physical WordPress install and only one should be listed.
 */
export interface DedupCandidate {
  domain: string;
  docroot: string;
  type: DomainEntry['type'];
}

/** Normalize a docroot for equality comparison: strip trailing slashes, lowercase. */
export function normalizeDocroot(docroot: string): string {
  return docroot.replace(/\/+$/, '').toLowerCase();
}

/** Compare hosts ignoring a leading `www.` and case, so `www.example.com` === `example.com`. */
export function registrableHost(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}

function groupByDocroot(candidates: DedupCandidate[]): Map<string, DedupCandidate[]> {
  const groups = new Map<string, DedupCandidate[]>();
  for (const c of candidates) {
    const key = normalizeDocroot(c.docroot);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(c);
    } else {
      groups.set(key, [c]);
    }
  }
  return groups;
}

/**
 * Domains that share a docroot with at least one other domain. These are the
 * only ones worth an HTTP redirect probe — a domain that owns its docroot alone
 * is unambiguous and needs no network round-trip.
 */
export function conflictingDomains(candidates: DedupCandidate[]): string[] {
  const conflicts: string[] = [];
  for (const group of groupByDocroot(candidates).values()) {
    if (group.length > 1) {
      conflicts.push(...group.map((c) => c.domain));
    }
  }
  return conflicts;
}

/** True if any path segment of the docroot exactly matches the domain or its SLD label. */
function docrootNamesDomain(docroot: string, domain: string): boolean {
  const segments = normalizeDocroot(docroot).split('/').filter(Boolean);
  const full = domain.toLowerCase();
  const label = full.split('.')[0] ?? full;
  return segments.includes(full) || segments.includes(label);
}

const TYPE_RANK: Record<DomainEntry['type'], number> = {
  main: 0,
  addon: 1,
  sub: 2,
  alias: 3,
  parked: 4,
};

/**
 * Choose the single canonical domain for a set of domains that share a docroot.
 * Preference order:
 *   1. A domain the HTTP probe confirmed serves itself (didn't redirect off-host)
 *      over one that redirects away (a redirect-only / email domain).
 *   2. A domain whose folder is named after it (cPanel's default for the owning domain).
 *   3. cPanel domain type: main > addon > sub > alias > parked.
 *   4. Longer domain label (more specific), then alphabetical — purely for determinism.
 */
function pickCanonical(
  group: DedupCandidate[],
  effectiveHosts: Map<string, string | null>
): DedupCandidate {
  const scored = group.map((c) => {
    const effective = effectiveHosts.get(c.domain) ?? null;
    const own = registrableHost(c.domain);
    const redirectsAway = effective !== null && registrableHost(effective) !== own;
    const selfConfirmed = effective !== null && registrableHost(effective) === own;
    return { c, redirectsAway, selfConfirmed };
  });

  // Drop domains that demonstrably redirect off their own host, unless that would
  // leave nothing (all inconclusive/redirecting) — then keep the whole group so we
  // never hide a real site on a failed probe.
  const survivors = scored.filter((s) => !s.redirectsAway);
  const pool = survivors.length > 0 ? survivors : scored;

  pool.sort((a, b) => {
    if (a.selfConfirmed !== b.selfConfirmed) {
      return a.selfConfirmed ? -1 : 1;
    }
    const aNamed = docrootNamesDomain(a.c.docroot, a.c.domain);
    const bNamed = docrootNamesDomain(b.c.docroot, b.c.domain);
    if (aNamed !== bNamed) {
      return aNamed ? -1 : 1;
    }
    if (TYPE_RANK[a.c.type] !== TYPE_RANK[b.c.type]) {
      return TYPE_RANK[a.c.type] - TYPE_RANK[b.c.type];
    }
    if (a.c.domain.length !== b.c.domain.length) {
      return b.c.domain.length - a.c.domain.length;
    }
    return a.c.domain.localeCompare(b.c.domain);
  });

  return pool[0]!.c;
}

/**
 * Reduce a set of WordPress-detected domains to one per physical docroot.
 * `effectiveHosts` maps a domain to the host it lands on after following HTTP
 * redirects (or null if the probe was inconclusive); it only needs entries for
 * domains returned by {@link conflictingDomains}.
 *
 * Returns the set of domains to keep.
 */
export function dedupeByDocroot(
  candidates: DedupCandidate[],
  effectiveHosts: Map<string, string | null>
): Set<string> {
  const keep = new Set<string>();
  for (const group of groupByDocroot(candidates).values()) {
    if (group.length === 1) {
      keep.add(group[0]!.domain);
    } else {
      keep.add(pickCanonical(group, effectiveHosts).domain);
    }
  }
  return keep;
}
