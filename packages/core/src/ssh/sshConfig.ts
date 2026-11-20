import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalDockError } from '../errors.js';
import { processRunner, type CommandRunner } from '../ddev/runner.js';
import type { Logger } from '../log.js';
import { SshConnection } from './SshConnection.js';

/**
 * SSH hosts as the user's own `ssh` sees them: the aliases in ~/.ssh/config,
 * resolved with `ssh -G` (so Include, Match and defaults work exactly as in a
 * terminal), and trusted only if their key is in the user's known_hosts.
 * LocalDock then opens its own connection with those details.
 */

export interface SshConfigHost {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  /** Identity files that exist, in the order ssh would try them. */
  identityFiles: string[];
  /** The name known_hosts records this host under (`[host]:port` off port 22, or HostKeyAlias). */
  knownHostsName: string;
  knownHostsFiles: string[];
  /** A ProxyJump or ProxyCommand, which LocalDock's connection can't follow. */
  proxy?: string;
}

const SAFE_ALIAS = /^[A-Za-z0-9._@%+=:,~-]+$/;

/** Usable as a command-line argument: no option injection, no spaces. */
export function isSafeSshAlias(alias: string): boolean {
  return SAFE_ALIAS.test(alias) && !alias.startsWith('-');
}

function home(): string {
  return os.homedir();
}

function expandHome(p: string): string {
  return p === '~' ? home() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(home(), p.slice(2)) : p;
}

/** The `ssh` and `ssh-keygen` to run: Windows' own OpenSSH when it's there, else whatever is on PATH. */
export function sshTool(name: 'ssh' | 'ssh-keygen', platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
    const builtIn = path.win32.join(systemRoot, 'System32', 'OpenSSH', `${name}.exe`);
    if (existsSync(builtIn)) return builtIn;
  }
  return name;
}

/** Host aliases defined in an ssh config (and the files it Includes). Wildcard and negated patterns are left out. */
export async function listSshConfigAliases(configFile = path.join(home(), '.ssh', 'config'), depth = 0): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(configFile, 'utf-8');
  } catch {
    return [];
  }
  const aliases: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^(\w+)\s*=?\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const args = m[2]!.split(/\s+/).filter(Boolean).map((a) => a.replace(/^"(.*)"$/, '$1'));
    if (key === 'host') {
      for (const a of args) if (!/[*?!]/.test(a) && isSafeSshAlias(a)) aliases.push(a);
    } else if (key === 'include' && depth < 4) {
      for (const pattern of args) {
        for (const file of await expandInclude(pattern)) aliases.push(...(await listSshConfigAliases(file, depth + 1)));
      }
    }
  }
  return [...new Set(aliases)];
}

/** An Include path: relative to ~/.ssh, with `*` allowed in its last part. */
async function expandInclude(pattern: string): Promise<string[]> {
  const full = path.isAbsolute(expandHome(pattern)) ? expandHome(pattern) : path.join(home(), '.ssh', pattern);
  const base = path.basename(full);
  if (!base.includes('*')) return [full];
  const re = new RegExp(`^${base.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  try {
    return (await fs.readdir(path.dirname(full))).filter((n) => re.test(n)).sort().map((n) => path.join(path.dirname(full), n));
  } catch {
    return [];
  }
}

/** Parse `ssh -G` output (lowercase keys; identityfile repeats). */
export function parseSshG(alias: string, output: string, exists: (p: string) => boolean = existsSync): SshConfigHost {
  const values = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const i = line.indexOf(' ');
    if (i <= 0) continue;
    const key = line.slice(0, i).toLowerCase();
    values.set(key, [...(values.get(key) ?? []), line.slice(i + 1).trim()]);
  }
  const one = (k: string) => values.get(k)?.[0];
  const hostname = one('hostname') ?? alias;
  const port = Number(one('port') ?? 22) || 22;
  const user = one('user') ?? os.userInfo().username;
  const identityFiles = (values.get('identityfile') ?? []).map(expandHome).filter((p) => exists(p));
  const alias2 = one('hostkeyalias');
  const knownHostsName = alias2 && alias2 !== 'none' ? alias2 : port === 22 ? hostname : `[${hostname}]:${port}`;
  const knownHostsFiles = [...(one('userknownhostsfile') ?? '~/.ssh/known_hosts').split(/\s+/), ...(one('globalknownhostsfile') ?? '').split(/\s+/)]
    .filter(Boolean)
    .map(expandHome);
  const proxy = [one('proxyjump'), one('proxycommand')].find((v) => v && v !== 'none');
  return { alias, hostname, port, user, identityFiles, knownHostsName, knownHostsFiles, ...(proxy ? { proxy } : {}) };
}

/** Resolve an alias the way `ssh <alias>` would, with `ssh -G`. */
export async function resolveSshHost(alias: string, runner: CommandRunner = processRunner): Promise<SshConfigHost> {
  if (!isSafeSshAlias(alias)) throw new LocalDockError(`Not a usable SSH host name: ${alias}`, 'UNSAFE_INPUT', false);
  const r = await runner.run(sshTool('ssh'), ['-G', alias]);
  if (r.code !== 0) {
    throw new LocalDockError(
      r.code === 127 ? 'OpenSSH (the ssh command) is not installed.' : `ssh -G ${alias} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      'NOT_FOUND',
      false,
    );
  }
  return parseSshG(alias, r.stdout);
}

/** SHA256 fingerprints of the keys known_hosts lists for a host (none: the user never connected to it). */
export async function knownHostKeys(host: SshConfigHost, runner: CommandRunner = processRunner): Promise<string[]> {
  const found = new Set<string>();
  for (const file of host.knownHostsFiles) {
    if (!existsSync(file)) continue;
    const r = await runner.run(sshTool('ssh-keygen'), ['-l', '-F', host.knownHostsName, '-f', file]);
    for (const m of r.stdout.matchAll(/SHA256:[A-Za-z0-9+/]+/g)) found.add(m[0]);
  }
  return [...found];
}

/**
 * Connect to an ssh config alias the way `ssh <alias>` would: its HostName,
 * User, Port and IdentityFiles, then the agent, trusting only the host keys
 * in the user's known_hosts. Jump hosts aren't supported yet.
 */
export async function connectSshAlias(alias: string, options: { runner?: CommandRunner; logger?: Logger } = {}): Promise<SshConnection> {
  const runner = options.runner ?? processRunner;
  const host = await resolveSshHost(alias, runner);
  if (host.proxy) {
    throw new LocalDockError(`${alias} connects through a jump host (${host.proxy}), which LocalDock can't do yet.`, 'UNSAFE_INPUT', false);
  }
  const known = await knownHostKeys(host, runner);
  return SshConnection.connect(
    {
      host: host.hostname,
      port: host.port,
      username: host.user,
      auth: { kind: 'keys-then-agent', keyPaths: host.identityFiles },
      knownHostKeys: known,
      trustCommand: `ssh ${alias}`,
    },
    options.logger ? { logger: options.logger } : {},
  );
}
