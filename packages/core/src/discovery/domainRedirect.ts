const PROBE_TIMEOUT_MS = 6000;

/**
 * Resolve the host a domain actually lands on after following HTTP redirects.
 * Used to tell a real site apart from a redirect-only domain that shares
 * another site's docroot: the redirect domain lands on a different host.
 *
 * Returns the final host (e.g. `www.example.com`), or null if the probe was
 * inconclusive. Callers treat null as "unknown" and keep the site visible.
 */
export async function resolveEffectiveHost(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  // Try HTTPS first, then HTTP: a redirect-only domain may have no valid
  // certificate but still issue its redirect over plain HTTP.
  for (const scheme of ['https', 'http'] as const) {
    try {
      const res = await fetchImpl(`${scheme}://${domain}/`, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { 'user-agent': 'LocalDock site discovery' },
      });
      await res.body?.cancel();
      return new URL(res.url || `${scheme}://${domain}/`).host;
    } catch {
      // Try the next scheme.
    }
  }
  return null;
}
