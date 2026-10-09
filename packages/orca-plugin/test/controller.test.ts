import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ddev, writeSiteState, type CommandRunner, type ExecResult, type RemoteFs, type RemoteShell } from '@localdock/core';
import { LocalDockController } from '../src/worker/controller.js';
import { OrcaApiPendingError } from '../src/shared/gaps.js';
import type { OrcaHost, ProjectInfo, RemoteSession, SshHostInfo } from '../src/worker/orca/host.js';
import type { PanelState } from '../src/shared/protocol.js';
import { PluginOrcaHost } from '../src/worker/orca/pluginHost.js';

const json = (o: unknown) => JSON.stringify(o);

/** A fake cPanel server: root session, one account, two WordPress sites and one non-WP domain. */
function fakeServerSession(): RemoteSession {
  const shell: RemoteShell = {
    exec: async (cmd): Promise<ExecResult> => {
      if (cmd === 'id -u') return { code: 0, stdout: '0\n', stderr: '' };
      if (cmd.startsWith(`'whmapi1'`)) {
        return { code: 0, stderr: '', stdout: json({ metadata: { result: 1 }, data: { acct: [{ user: 'exampleco', domain: 'example.com', suspended: 0 }] } }) };
      }
      if (cmd.startsWith(`'uapi'`)) {
        return {
          code: 0,
          stderr: '',
          stdout: json({
            result: {
              status: 1,
              data: {
                main_domain: { domain: 'example.com', documentroot: '/home/exampleco/public_html' },
                addon_domains: [
                  { domain: 'shop.example.com', documentroot: '/home/exampleco/shop' },
                  { domain: 'static.example.com', documentroot: '/home/exampleco/static' },
                ],
                sub_domains: [],
                parked_domains: [],
              },
            },
          }),
        };
      }
      return { code: 1, stdout: '', stderr: `unexpected: ${cmd}` };
    },
  };
  const wp = new Set(['/home/exampleco/public_html', '/home/exampleco/shop']);
  const sftp = {
    readFile: async (p: string) => {
      const root = p.replace(/\/wp-includes\/version\.php$/, '');
      if (p.endsWith('/wp-includes/version.php') && wp.has(root)) return Buffer.from(`<?php $wp_version = '6.8.1';`);
      throw new Error('No such file');
    },
    stat: async (p: string) => {
      if (wp.has(p.replace(/\/wp-load\.php$/, ''))) return { isDirectory: false, isFile: true, size: 1, mtime: 1, uid: 0, gid: 0 };
      throw new Error('No such file');
    },
  } as unknown as RemoteFs;
  return { shell, sftp, close: () => {} };
}

class FakeHost implements OrcaHost {
  project: ProjectInfo | null = null;
  hosts: SshHostInfo[] = [];
  sessionGap = false;
  session?: RemoteSession;
  opened: string[] = [];
  notes: string[] = [];
  store = new Map<string, unknown>();
  async activeProject() {
    return this.project;
  }
  async listSshHosts() {
    return this.hosts;
  }
  async connectSshHost(id: string) {
    const h = this.hosts.find((x) => x.id === id);
    if (h) h.connected = true;
  }
  async openSession(): Promise<RemoteSession> {
    if (this.sessionGap) throw new OrcaApiPendingError('ssh-session');
    return this.session ?? fakeServerSession();
  }
  async openUrl(url: string) {
    this.opened.push(url);
  }
  async notify(title: string) {
    this.notes.push(title);
  }
  async storageGet<T>(key: string) {
    return this.store.get(key) as T | undefined;
  }
  async storageSet(key: string, value: unknown) {
    this.store.set(key, value);
  }
  log() {}
}

const noDdev: CommandRunner = { run: async () => ({ code: 127, stdout: '', stderr: 'not found' }) };

describe('LocalDockController', () => {
  let host: FakeHost;
  let published: PanelState[];
  let ctl: LocalDockController;
  let dir: string;

  beforeEach(async () => {
    host = new FakeHost();
    published = [];
    ctl = new LocalDockController({ host, ddev: new Ddev(noDdev), publish: (s) => published.push(s) });
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-proj-'));
  });

  it('asks for a project when none is open', async () => {
    expect((await ctl.dispatch({ type: 'refresh' })).view).toBe('no-project');
  });

  it('offers no servers in a project that already has files', async () => {
    host.project = { path: dir, name: 'main' };
    host.hosts = [{ id: 'h1', label: 'Example server', host: 'server.example.com', port: 22, username: 'root', connected: true }];
    await fs.mkdir(path.join(dir, '.git'));
    expect((await ctl.dispatch({ type: 'refresh' })).view).toBe('choose-host');

    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    expect(await ctl.dispatch({ type: 'refresh' })).toMatchObject({ view: 'project-not-empty', projectName: path.basename(dir) });
    expect((await ctl.dispatch({ type: 'back-to-hosts' })).view).toBe('project-not-empty');
    expect((await ctl.dispatch({ type: 'scan-sites', hostId: 'h1' })).view).toBe('project-not-empty');
  });

  it('keeps a running pull with its own project when the user switches away and back', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-other-'));
    await fs.writeFile(path.join(other, 'index.php'), '');
    host.project = { path: dir, name: 'main' };
    host.hosts = [{ id: 'h1', label: 'x', host: 'server.example.com', port: 22, username: 'root', connected: true }];
    await ctl.dispatch({ type: 'scan-sites', hostId: 'h1' });

    // Hold the pull at its first server read (wp-config.php) until released.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const base = fakeServerSession();
    const readFile = base.sftp.readFile.bind(base.sftp);
    host.session = {
      ...base,
      sftp: Object.assign(Object.create(base.sftp), {
        readFile: async (p: string) => {
          if (p.endsWith('wp-config.php')) {
            await held;
            throw new Error('No such file');
          }
          return readFile(p);
        },
      }),
    };
    (ctl as unknown as { sessions: Map<string, unknown> }).sessions.clear();
    const pulling = ctl.dispatch({ type: 'pull-site', hostId: 'h1', account: 'exampleco', domain: 'example.com' });
    await vi.waitFor(() => expect(ctl.state().job?.title).toBe('Pulling example.com'));

    // A refresh in the same project (the focus poll) keeps the job and the pulling view.
    expect(await ctl.dispatch({ type: 'refresh' })).toMatchObject({ view: 'pulling', job: { title: 'Pulling example.com' } });

    // In another project the job is hidden behind a notice.
    host.project = { path: other, name: 'main' };
    const away = await ctl.dispatch({ type: 'refresh' });
    expect(away).toMatchObject({ view: 'project-not-empty', job: null, notice: { kind: 'info' } });
    expect(away.notice?.text).toContain(path.basename(dir));

    // Back in the pull's project: the pulling view and job return, though .localdock now exists.
    host.project = { path: dir, name: 'main' };
    expect(await ctl.dispatch({ type: 'refresh' })).toMatchObject({ view: 'pulling', job: { title: 'Pulling example.com' } });

    release();
    await pulling;
    expect(ctl.state().job).toBeNull();
  });

  it('asks for an SSH host when Orca has none', async () => {
    host.project = { path: dir, name: 'p' };
    expect((await ctl.dispatch({ type: 'refresh' })).view).toBe('no-hosts');
  });

  it('lists hosts, connects, and scans for WordPress sites', async () => {
    host.project = { path: dir, name: 'p' };
    host.hosts = [{ id: 'h1', label: 'Example server', host: 'server.example.com', port: 22, username: 'root', connected: false }];
    const s1 = await ctl.dispatch({ type: 'refresh' });
    expect(s1).toMatchObject({ view: 'choose-host', hosts: [{ id: 'h1', detail: 'root@server.example.com', connected: false }] });

    expect(await ctl.dispatch({ type: 'connect-host', hostId: 'h1' })).toMatchObject({ view: 'choose-host', hosts: [{ connected: true }] });

    const s3 = await ctl.dispatch({ type: 'scan-sites', hostId: 'h1' });
    expect(s3.view).toBe('site-list');
    if (s3.view !== 'site-list') return;
    expect(s3.projectEmpty).toBe(true);
    expect(s3.sites.map((s) => s.domain)).toEqual(['example.com', 'shop.example.com']);
    expect(s3.job).toBeNull();
    expect(published.some((p) => p.view === 'scanning')).toBe(true);
  });

  it('refuses to pull a site it did not discover', async () => {
    host.project = { path: dir, name: 'p' };
    host.hosts = [{ id: 'h1', label: 'x', host: 'server.example.com', port: 22, username: 'root', connected: true }];
    const s = await ctl.dispatch({ type: 'pull-site', hostId: 'h1', account: 'exampleco', domain: 'evil.example.net' });
    expect(s.notice).toMatchObject({ kind: 'error' });
  });

  it('shows the gap when Orca cannot provide what a step needs', async () => {
    host.project = { path: dir, name: 'p' };
    host.hosts = [{ id: 'h1', label: 'x', host: 'server.example.com', port: 22, username: 'root', connected: true }];
    host.sessionGap = true;
    const s = await ctl.dispatch({ type: 'scan-sites', hostId: 'h1' });
    expect(s).toMatchObject({ view: 'awaiting-orca', gaps: [{ id: 'ssh-session' }], blockedAction: 'scan-sites' });
  });

  it('switches to the source-control view for a project that holds a pulled site', async () => {
    host.project = { path: dir, name: 'p' };
    host.store.set('hostLabels', { h1: 'Example server' });
    await writeSiteState(dir, {
      version: 1, hostId: 'h1', account: 'exampleco', domain: 'example.com', docroot: '/home/exampleco/public_html',
      productionUrl: 'https://example.com', tablePrefix: 'wp_', pulledAt: new Date().toISOString(), files: {},
    });
    const s = await ctl.dispatch({ type: 'refresh' });
    expect(s).toMatchObject({ view: 'tracking', site: { domain: 'example.com', hostLabel: 'Example server' }, ddev: { status: 'not-installed' }, changes: null });

    await ctl.dispatch({ type: 'open', target: 'live' });
    expect(host.opened).toEqual(['https://example.com']);
    expect((await ctl.dispatch({ type: 'start' })).notice?.text).toMatch(/DDEV is not installed/);
  });

  it('rejects malformed actions without running anything', async () => {
    const s = await ctl.dispatch({ type: 'push-files', paths: [] });
    expect(s.notice).toMatchObject({ kind: 'error' });
    expect((await ctl.dispatch({ type: 'nope' })).notice).toMatchObject({ kind: 'error' });
  });
});

describe('PluginOrcaHost (Orca 1.4.222)', () => {
  const orca = (ctx: unknown) => ({
    commands: { register: () => {} },
    events: { on: () => {} },
    host: { call: async (m: string) => (m === 'workspace.readContext' ? ctx : { delivered: true }) },
    log: () => {},
  });

  it('treats no workspace as no project, and an open one as the project-path gap', async () => {
    expect(await new PluginOrcaHost(orca(null)).activeProject()).toBeNull();
    await expect(new PluginOrcaHost(orca({ branch: 'main', displayName: 'p', terminals: [] })).activeProject()).rejects.toMatchObject({ gap: 'project-path' });
  });

  it('reports every SSH and browser capability as pending', async () => {
    const h = new PluginOrcaHost(orca(null));
    await expect(h.listSshHosts()).rejects.toMatchObject({ gap: 'ssh-hosts' });
    await expect(h.connectSshHost('x')).rejects.toMatchObject({ gap: 'ssh-hosts' });
    await expect(h.openSession('x')).rejects.toMatchObject({ gap: 'ssh-session' });
    await expect(h.openUrl('https://example.com')).rejects.toMatchObject({ gap: 'open-url' });
  });
});
