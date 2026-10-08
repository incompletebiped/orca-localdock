import { LocalDockError, throwIfAborted } from '../errors.js';
import { silentLogger, type Logger } from '../log.js';
import type { RemoteFs, RemoteShell } from '../ssh/types.js';
import { mapLimit } from '../util/concurrency.js';
import { assertSafeRemoteDir } from '../util/remotePath.js';
import { isValidCpanelUser, isValidDomain, shellCommand } from '../util/shell.js';
import { parseUapiDomainsData, parseWhmListAccts, type DomainEntry, type DomainType } from './cpanelApi.js';
import { conflictingDomains, dedupeByDocroot } from './docrootDedup.js';
import { resolveEffectiveHost } from './domainRedirect.js';
import { parseWpVersion } from './wpConfig.js';

export interface DiscoveredSite {
  account: string;
  domain: string;
  docroot: string;
  type: DomainType;
  wpVersion: string;
  /** Other domains that point at the same WordPress install. */
  aliases: string[];
}

export interface DiscoverOptions {
  signal?: AbortSignal;
  logger?: Logger;
  onProgress?: (message: string) => void;
  /** Override the redirect probe (tests). */
  probeHost?: (domain: string) => Promise<string | null>;
}

/** True when the SSH session is root, i.e. can see every cPanel account via WHM. */
export async function isRootSession(shell: RemoteShell): Promise<boolean> {
  const res = await shell.exec('id -u');
  return res.code === 0 && res.stdout.trim() === '0';
}

/** List cPanel accounts. As root via WHM; otherwise just the logged-in account. */
export async function listAccounts(shell: RemoteShell, sshUser: string, asRoot: boolean): Promise<string[]> {
  if (!asRoot) {
    return [sshUser];
  }
  const res = await shell.exec(shellCommand(['whmapi1', '--output=json', 'listaccts']));
  if (res.code !== 0 && !res.stdout.includes('{')) {
    throw new LocalDockError(
      `whmapi1 is not available (${res.stderr.trim() || `exit ${res.code}`}). Is this a cPanel/WHM server?`,
      'REMOTE_COMMAND_FAILED',
    );
  }
  return parseWhmListAccts(res.stdout)
    .filter((a) => !a.suspended && isValidCpanelUser(a.user))
    .map((a) => a.user);
}

export async function listDomains(shell: RemoteShell, account: string, asRoot: boolean): Promise<DomainEntry[]> {
  const argv = ['uapi', ...(asRoot ? [`--user=${account}`] : []), '--output=json', 'DomainInfo', 'domains_data'];
  const res = await shell.exec(shellCommand(argv));
  return parseUapiDomainsData(res.stdout).filter((d) => isValidDomain(d.domain));
}

/** Detect a WordPress install in a docroot by reading wp-includes/version.php. */
export async function detectWordPress(sftp: RemoteFs, docroot: string): Promise<string | null> {
  const root = assertSafeRemoteDir(docroot);
  try {
    const version = parseWpVersion((await sftp.readFile(`${root}/wp-includes/version.php`, 256 * 1024)).toString('utf-8'));
    await sftp.stat(`${root}/wp-load.php`);
    return version ?? 'unknown';
  } catch {
    return null;
  }
}

/**
 * Find every WordPress site the SSH user can reach. Domains sharing a docroot
 * collapse to one site (the others become aliases), choosing the canonical
 * domain with an HTTP redirect probe when it's ambiguous.
 */
export async function discoverSites(
  shell: RemoteShell,
  sftp: RemoteFs,
  sshUser: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredSite[]> {
  const log = (options.logger ?? silentLogger).child('discover');
  const asRoot = await isRootSession(shell);
  options.onProgress?.(asRoot ? 'Listing cPanel accounts…' : 'Listing domains…');
  const accounts = await listAccounts(shell, sshUser, asRoot);
  log.info(`Found ${accounts.length} account(s) (${asRoot ? 'root/WHM' : 'single account'})`);

  const sites: DiscoveredSite[] = [];
  let checked = 0;
  await mapLimit(
    accounts,
    4,
    async (account) => {
      throwIfAborted(options.signal);
      let domains: DomainEntry[];
      try {
        domains = await listDomains(shell, account, asRoot);
      } catch (err) {
        log.warn(`Skipping account ${account}: ${(err as Error).message}`);
        return;
      }
      const found: Array<DomainEntry & { wpVersion: string }> = [];
      await mapLimit(
        domains,
        8,
        async (d) => {
          let docroot: string;
          try {
            docroot = assertSafeRemoteDir(d.docroot);
          } catch {
            log.warn(`Skipping ${d.domain}: unsafe docroot`);
            return;
          }
          const wpVersion = await detectWordPress(sftp, docroot);
          if (wpVersion) found.push({ ...d, docroot, wpVersion });
        },
        options.signal,
      );

      const conflicts = conflictingDomains(found);
      const probe = options.probeHost ?? ((domain: string) => resolveEffectiveHost(domain));
      const hosts = new Map<string, string | null>();
      await mapLimit(conflicts, 6, async (domain) => hosts.set(domain, await probe(domain)), options.signal);
      const keep = dedupeByDocroot(found, hosts);

      for (const d of found) {
        if (!keep.has(d.domain)) continue;
        const aliases = found
          .filter((o) => o.domain !== d.domain && o.docroot.toLowerCase() === d.docroot.toLowerCase())
          .map((o) => o.domain);
        sites.push({ account, domain: d.domain, docroot: d.docroot, type: d.type, wpVersion: d.wpVersion, aliases });
      }
      options.onProgress?.(`Checked ${++checked} of ${accounts.length} account(s)…`);
    },
    options.signal,
  );

  return sites.sort((a, b) => a.account.localeCompare(b.account) || a.domain.localeCompare(b.domain));
}
