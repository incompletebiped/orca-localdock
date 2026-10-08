import { z } from 'zod';
import { LocalDockError } from '../errors.js';

/**
 * Parsers for the JSON that `whmapi1 --output=json` and `uapi --output=json`
 * print on a cPanel server. They validate the shape and drop anything we
 * don't use, so unexpected server output can't flow further into LocalDock.
 */

export type DomainType = 'main' | 'addon' | 'sub' | 'alias' | 'parked';

export interface CpanelAccount {
  user: string;
  domain: string;
  homedir?: string;
  suspended: boolean;
}

export interface DomainEntry {
  domain: string;
  docroot: string;
  type: DomainType;
}

const whmListAccts = z.object({
  metadata: z.object({ result: z.union([z.number(), z.string()]), reason: z.string().optional() }),
  data: z
    .object({
      acct: z
        .array(
          z
            .object({
              user: z.string(),
              domain: z.string(),
              homedir: z.string().optional(),
              suspended: z.union([z.number(), z.string(), z.boolean()]).optional(),
            })
            .passthrough(),
        )
        .default([]),
    })
    .optional(),
});

export function parseWhmListAccts(json: string): CpanelAccount[] {
  const parsed = whmListAccts.parse(parseJson(json, 'whmapi1 listaccts'));
  if (String(parsed.metadata.result) !== '1') {
    throw new LocalDockError(
      `whmapi1 listaccts failed: ${parsed.metadata.reason ?? 'unknown reason'}`,
      'REMOTE_COMMAND_FAILED',
    );
  }
  return (parsed.data?.acct ?? []).map((a) => ({
    user: a.user,
    domain: a.domain,
    homedir: a.homedir,
    suspended: a.suspended === true || String(a.suspended) === '1',
  }));
}

const domainRecord = z
  .object({ domain: z.string(), documentroot: z.string().optional() })
  .passthrough();

const uapiDomainsData = z.object({
  result: z.object({
    status: z.union([z.number(), z.string()]),
    errors: z.array(z.string()).nullable().optional(),
    data: z
      .object({
        main_domain: domainRecord.nullable().optional(),
        addon_domains: z.array(domainRecord).default([]),
        sub_domains: z.array(domainRecord).default([]),
        parked_domains: z.array(z.union([z.string(), domainRecord])).default([]),
      })
      .optional(),
  }),
});

/**
 * Parse `uapi DomainInfo domains_data`. Parked domains (aliases) share the
 * main domain's docroot, so they get that docroot here.
 */
export function parseUapiDomainsData(json: string): DomainEntry[] {
  const parsed = uapiDomainsData.parse(parseJson(json, 'uapi DomainInfo domains_data'));
  if (String(parsed.result.status) !== '1') {
    throw new LocalDockError(
      `uapi DomainInfo domains_data failed: ${(parsed.result.errors ?? []).join(', ') || 'unknown reason'}`,
      'REMOTE_COMMAND_FAILED',
    );
  }
  const data = parsed.result.data;
  if (!data) {
    return [];
  }
  const entries: DomainEntry[] = [];
  const push = (domain: string, docroot: string | undefined, type: DomainType) => {
    if (domain && docroot) {
      entries.push({ domain, docroot, type });
    }
  };
  const mainRoot = data.main_domain?.documentroot;
  if (data.main_domain) {
    push(data.main_domain.domain, mainRoot, 'main');
  }
  for (const d of data.addon_domains) push(d.domain, d.documentroot, 'addon');
  for (const d of data.sub_domains) push(d.domain, d.documentroot, 'sub');
  for (const d of data.parked_domains) {
    if (typeof d === 'string') push(d, mainRoot, 'parked');
    else push(d.domain, d.documentroot ?? mainRoot, 'parked');
  }
  return entries;
}

function parseJson(text: string, what: string): unknown {
  // Some cPanel builds print warnings before the JSON body.
  const start = text.indexOf('{');
  if (start === -1) {
    throw new LocalDockError(`${what} returned no JSON`, 'REMOTE_COMMAND_FAILED');
  }
  try {
    return JSON.parse(text.slice(start));
  } catch (err) {
    throw new LocalDockError(`${what} returned invalid JSON`, 'REMOTE_COMMAND_FAILED', true, { cause: err });
  }
}
