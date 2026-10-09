import * as path from 'node:path';
import {
  LocalDockError,
  TABLE_GROUPS,
  computeSiteChanges,
  createLogger,
  discoverSites,
  isCancelled,
  isEmptyProject,
  isRootSession,
  localTableGroups,
  pullDatabase,
  pullFiles,
  pullSite,
  pushDatabase,
  pushFiles,
  readSiteState,
  rollbackDatabase,
  startSite,
  stopSite,
  type Ddev,
  type DiscoveredSite,
  type Logger,
  type OperationContext,
  type SiteState,
  type TableGroup,
} from '@localdock/core';
import { GAPS, isOrcaApiPending } from '../shared/gaps.js';
import { panelActionSchema } from '../shared/actionSchema.js';
import {
  type DdevInfo,
  type HostSummary,
  type Job,
  type Notice,
  type PanelAction,
  type PanelState,
  type PanelView,
  type SiteSummary,
  type TableGroupOption,
} from '../shared/protocol.js';
import type { OrcaHost, ProjectInfo, RemoteSession, SshHostInfo } from './orca/host.js';

export interface ControllerDeps {
  host: OrcaHost;
  ddev: Ddev;
  /** Called whenever the panel state changes. */
  publish: (state: PanelState) => void;
  concurrency?: number;
}

const HOST_LABELS_KEY = 'hostLabels';

function hostSummary(h: SshHostInfo): HostSummary {
  return { id: h.id, label: h.label, detail: `${h.username}@${h.host}${h.port === 22 ? '' : `:${h.port}`}`, connected: h.connected };
}

function siteSummary(s: DiscoveredSite): SiteSummary {
  return { account: s.account, domain: s.domain, docroot: s.docroot, wpVersion: s.wpVersion, aliases: s.aliases };
}

/**
 * The plugin's state machine. It owns the panel state, turns panel actions
 * into engine operations, and reports progress. It talks to Orca only
 * through OrcaHost, so it runs (and is tested) without Orca.
 */
export class LocalDockController {
  private view: PanelView = { view: 'loading' };
  private job: Job | null = null;
  /** The panel notice and the project it's about; it only shows in that project. */
  private noticeEntry: { notice: Notice; dir: string | null } | null = null;
  private revision = 0;
  private abort: AbortController | null = null;
  private readonly sessions = new Map<string, { session: RemoteSession; asRoot: boolean; username: string }>();
  private discovered: { hostId: string; sites: DiscoveredSite[] } | null = null;
  private project: ProjectInfo | null = null;
  /** The project a running job works in, and the view it showed, so switching projects mid-job keeps them apart. */
  private jobHome: { dir: string; view: PanelView } | null = null;
  private ddevVersion: string | null = null;
  private readonly logger: Logger;

  constructor(private readonly deps: ControllerDeps) {
    this.logger = createLogger((e) => deps.host.log(`[${e.level}] ${e.scope}: ${e.message}`));
  }

  state(): PanelState {
    const away = this.job && this.jobHome && !this.here(this.jobHome.dir) ? this.jobHome : null;
    if (!away) return { ...this.view, revision: this.revision, job: this.job, notice: this.notice };
    const elsewhere: Notice = { kind: 'info', text: `${this.job!.title} is running in ${path.basename(away.dir)}. Switch back to that project to follow or cancel it.` };
    return { ...this.view, revision: this.revision, job: null, notice: this.notice ?? elsewhere };
  }

  private get notice(): Notice | null {
    const e = this.noticeEntry;
    return e && (e.dir === null || this.here(e.dir)) ? e.notice : null;
  }

  private set notice(notice: Notice | null) {
    this.noticeEntry = notice && { notice, dir: this.jobHome?.dir ?? this.project?.path ?? null };
  }

  private here(dir: string): boolean {
    return this.project?.path === dir;
  }

  private emit(): void {
    this.revision++;
    this.deps.publish(this.state());
  }

  private setView(view: PanelView): void {
    this.view = view;
    this.emit();
  }

  private setNotice(notice: Notice | null): void {
    this.notice = notice;
    this.emit();
  }

  /** Validate and run one action from the panel (or a command). Never throws. */
  async dispatch(raw: unknown): Promise<PanelState> {
    const parsed = panelActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.setNotice({ kind: 'error', text: `Ignored an invalid action: ${parsed.error.issues[0]?.message ?? 'unknown'}` });
      return this.state();
    }
    const action = parsed.data;
    if (action.type === 'cancel') {
      this.abort?.abort();
      return this.state();
    }
    if (action.type === 'dismiss-notice') {
      this.setNotice(null);
      return this.state();
    }
    if (this.job && action.type !== 'refresh') {
      this.setNotice({ kind: 'info', text: `Wait for "${this.job.title}" to finish.` });
      return this.state();
    }
    // Only a refresh can run alongside a job; it must leave that job (and its cancel handle) alone.
    const ownsJob = this.job === null;
    try {
      await this.run(action);
    } catch (err) {
      this.fail(err, action.type);
    } finally {
      if (ownsJob && this.job) {
        this.job = null;
        this.jobHome = null;
        this.abort = null;
        this.emit();
      }
    }
    return this.state();
  }

  private fail(err: unknown, actionType: string): void {
    if (isOrcaApiPending(err)) {
      this.view = { view: 'awaiting-orca', gaps: [GAPS[err.gap]], blockedAction: actionType };
      this.notice = null;
      this.emit();
      return;
    }
    if (isCancelled(err)) {
      this.setNotice({ kind: 'info', text: 'Cancelled.' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`${actionType}: ${message}`);
    this.setNotice({ kind: 'error', text: message });
  }

  private async run(action: PanelAction): Promise<void> {
    switch (action.type) {
      case 'refresh':
        return this.refresh();
      case 'connect-host':
        await this.deps.host.connectSshHost(action.hostId);
        return this.showHosts();
      case 'back-to-hosts':
        this.discovered = null;
        return this.showHosts();
      case 'scan-sites':
        return this.scanSites(action.hostId);
      case 'pull-site':
        return this.pull(action.hostId, action.account, action.domain, action.includeUploads);
      case 'scan-changes':
        return this.scanChanges();
      case 'push-files':
      case 'pull-files':
        return this.syncFiles(action.type === 'push-files' ? 'push' : 'pull', action.paths, action.allowConflicts);
      case 'start':
      case 'stop':
        return this.startStop(action.type);
      case 'open':
        return this.open(action.target);
      case 'load-db-groups':
        return this.loadDbGroups();
      case 'push-db':
        return this.pushDb(action.groups);
      case 'pull-db':
        return this.tracked('Pulling the database', true, async (ctx, dir) => {
          await pullDatabase(ctx, dir);
          this.notice = { kind: 'success', text: 'Local database replaced with the live one.' };
          await this.refreshTracking();
        });
      case 'rollback-db':
        return this.tracked('Restoring the live database', false, async (ctx, dir) => {
          await rollbackDatabase(ctx, dir, action.backupPath);
          this.notice = { kind: 'success', text: 'Live database restored from the backup.' };
          this.emit();
        });
    }
  }

  // ---- views --------------------------------------------------------------

  /** Decide what the panel shows for the active project. */
  async refresh(): Promise<void> {
    this.project = await this.deps.host.activeProject();
    if (!this.project) return this.setView({ view: 'no-project' });
    if (this.job && this.jobHome && this.here(this.jobHome.dir)) return this.setView(this.jobHome.view);
    const state = await readSiteState(this.project.path);
    if (state) return this.refreshTracking(state);
    if (!(await this.requireEmptyProject())) return;
    if (this.discovered) {
      const host = (await this.deps.host.listSshHosts()).find((h) => h.id === this.discovered!.hostId);
      if (host) {
        return this.setView({
          view: 'site-list',
          host: hostSummary(host),
          sites: this.discovered.sites.map(siteSummary),
          projectEmpty: await isEmptyProject(this.project.path),
        });
      }
    }
    return this.showHosts();
  }

  /** Servers are only offered in an empty project, since a pull fills the project folder. */
  private async requireEmptyProject(): Promise<ProjectInfo | null> {
    const project = await this.requireProject();
    if (await isEmptyProject(project.path)) return project;
    this.discovered = null;
    this.setView({ view: 'project-not-empty', projectName: path.basename(project.path) });
    return null;
  }

  private async showHosts(): Promise<void> {
    if (!(await this.requireEmptyProject())) return;
    const hosts = await this.deps.host.listSshHosts();
    this.setView(hosts.length === 0 ? { view: 'no-hosts' } : { view: 'choose-host', hosts: hosts.map(hostSummary) });
  }

  private async requireProject(): Promise<ProjectInfo> {
    this.project ??= await this.deps.host.activeProject();
    if (!this.project) throw new LocalDockError('Open a project in Orca first.', 'NOT_FOUND', false);
    return this.project;
  }

  private async requireHost(hostId: string): Promise<SshHostInfo> {
    const host = (await this.deps.host.listSshHosts()).find((h) => h.id === hostId);
    if (!host) throw new LocalDockError('That SSH host is no longer configured in Orca.', 'NOT_FOUND', false);
    if (!host.connected) await this.deps.host.connectSshHost(hostId);
    return host;
  }

  private async session(hostId: string) {
    let entry = this.sessions.get(hostId);
    if (!entry) {
      const host = await this.requireHost(hostId);
      const session = await this.deps.host.openSession(hostId);
      entry = { session, asRoot: await isRootSession(session.shell), username: host.username };
      this.sessions.set(hostId, entry);
    }
    return entry;
  }

  private async context(hostId: string, dir: string, title: string, cancellable: boolean): Promise<OperationContext> {
    const { session, asRoot } = await this.session(hostId);
    this.abort = new AbortController();
    this.jobHome = { dir, view: this.view };
    this.job = { title, message: 'Starting…', cancellable };
    this.emit();
    return {
      shell: session.shell,
      sftp: session.sftp,
      asRoot,
      ddev: this.deps.ddev,
      logger: this.logger,
      signal: this.abort.signal,
      concurrency: this.deps.concurrency ?? 12,
      progress: (u) => {
        this.job = { title, message: u.message, current: u.current, total: u.total, cancellable };
        this.emit();
      },
    };
  }

  private async scanSites(hostId: string): Promise<void> {
    const project = await this.requireEmptyProject();
    if (!project) return;
    const host = await this.requireHost(hostId);
    this.setView({ view: 'scanning', host: hostSummary(host) });
    const { session, username } = await this.session(hostId);
    const sites = await discoverSites(session.shell, session.sftp, username, {
      logger: this.logger,
      onProgress: (message) => {
        this.job = { title: 'Scanning for WordPress sites', message, cancellable: false };
        this.emit();
      },
    });
    this.job = null;
    this.discovered = { hostId, sites };
    this.setView({ view: 'site-list', host: hostSummary(host), sites: sites.map(siteSummary), projectEmpty: await isEmptyProject(project.path) });
  }

  private async pull(hostId: string, account: string, domain: string, includeUploads: boolean): Promise<void> {
    const project = await this.requireProject();
    // Only pull sites this worker discovered itself; the panel just names one.
    const site = this.discovered?.hostId === hostId ? this.discovered.sites.find((s) => s.account === account && s.domain === domain) : undefined;
    if (!site) throw new LocalDockError('Scan the server again; that site is not in the current list.', 'NOT_FOUND', false);
    const host = await this.requireHost(hostId);
    this.setView({ view: 'pulling', host: hostSummary(host), site: siteSummary(site) });

    const ctx = await this.context(hostId, project.path, `Pulling ${domain}`, true);
    const installed = (await this.ddevInstalled()) !== null;
    const result = await pullSite(ctx, { hostId, site, projectDir: project.path, exclude: { includeUploads }, start: installed });
    await this.rememberHostLabel(host);
    this.discovered = null;
    this.notice = result.failed.length
      ? { kind: 'error', text: `Pulled ${result.fileCount - result.failed.length} of ${result.fileCount} files. ${result.failed.length} failed: ${result.failed.slice(0, 3).map((f) => f.path).join(', ')}…` }
      : { kind: 'success', text: installed ? `Pulled ${domain} and started it with DDEV.` : `Pulled ${domain}. Install DDEV to run it locally.` };
    await this.deps.host.notify('LocalDock', `Pulled ${domain}`).catch(() => {});
    await (this.here(project.path) ? this.refreshTracking(result.state) : this.refresh());
  }

  private async refreshTracking(state?: SiteState): Promise<void> {
    const project = await this.requireProject();
    const s = state ?? (await readSiteState(project.path));
    if (!s) return this.refresh();
    const prev = this.view.view === 'tracking' ? this.view : null;
    this.setView({
      view: 'tracking',
      site: {
        domain: s.domain,
        productionUrl: s.productionUrl,
        account: s.account,
        hostId: s.hostId,
        hostLabel: (await this.hostLabel(s.hostId)) ?? 'SSH host',
        pulledAt: s.pulledAt,
        lastPushedAt: s.lastPushedAt,
      },
      ddev: await this.ddevInfo(project.path),
      changes: prev?.changes ?? null,
      dbGroups: prev?.dbGroups ?? null,
      lastBackup: prev?.lastBackup,
    });
  }

  /** Run an engine operation for the tracked site in this project. */
  private async tracked(title: string, cancellable: boolean, fn: (ctx: OperationContext, dir: string, state: SiteState) => Promise<void>): Promise<void> {
    const project = await this.requireProject();
    const state = await readSiteState(project.path);
    if (!state) throw new LocalDockError('This project has no pulled site.', 'NOT_FOUND', false);
    const ctx = await this.context(state.hostId, project.path, title, cancellable);
    await fn(ctx, project.path, state);
  }

  private async scanChanges(): Promise<void> {
    await this.tracked('Checking for changes', true, async (ctx, dir) => {
      const changes = await computeSiteChanges(ctx, dir);
      if (this.view.view === 'tracking' && this.here(dir)) {
        this.view = { ...this.view, changes: { rows: changes.entries, scannedAt: new Date().toISOString() } };
        this.emit();
      }
    });
  }

  private async syncFiles(direction: 'push' | 'pull', paths: string[], allowConflicts: boolean): Promise<void> {
    await this.tracked(direction === 'push' ? 'Pushing files' : 'Pulling files', true, async (ctx, dir) => {
      const r = direction === 'push' ? await pushFiles(ctx, dir, paths, { allowConflicts }) : await pullFiles(ctx, dir, paths, { allowConflicts });
      const verb = direction === 'push' ? 'Uploaded' : 'Downloaded';
      this.notice = r.failed.length
        ? { kind: 'error', text: `${verb} ${r.transferred.length}, removed ${r.deleted.length}; ${r.failed.length} failed (${r.failed[0]!.path}: ${r.failed[0]!.error}).` }
        : { kind: 'success', text: `${verb} ${r.transferred.length} file(s), removed ${r.deleted.length}.` };
      await this.refreshTracking();
    });
    await this.scanChanges();
  }

  private async startStop(which: 'start' | 'stop'): Promise<void> {
    if ((await this.ddevInstalled()) === null) {
      throw new LocalDockError('DDEV is not installed. See https://ddev.com/get-started/', 'DOCKER_NOT_FOUND', false);
    }
    await this.tracked(which === 'start' ? 'Starting DDEV' : 'Stopping DDEV', false, async (ctx, dir) => {
      if (which === 'start') await startSite(ctx, dir);
      else await stopSite(ctx, dir);
      await this.refreshTracking();
    });
  }

  private async open(target: 'site' | 'admin' | 'mailpit' | 'live'): Promise<void> {
    if (this.view.view !== 'tracking') return;
    const { ddev, site } = this.view;
    const url =
      target === 'live' ? site.productionUrl
      : target === 'mailpit' ? ddev.mailpitUrl
      : ddev.url && (target === 'admin' ? `${ddev.url.replace(/\/$/, '')}/wp-admin/` : ddev.url);
    if (!url) throw new LocalDockError('Start the local site first.', 'NOT_FOUND', false);
    await this.deps.host.openUrl(url);
  }

  private async loadDbGroups(): Promise<void> {
    const project = await this.requireProject();
    const groups = await localTableGroups(this.deps.ddev, project.path);
    const options: TableGroupOption[] = (Object.keys(TABLE_GROUPS) as TableGroup[])
      .filter((g) => groups[g].length > 0)
      .map((g) => ({ id: g, ...TABLE_GROUPS[g], tables: groups[g].length }));
    if (this.view.view === 'tracking') {
      this.view = { ...this.view, dbGroups: options };
      this.emit();
    }
  }

  private async pushDb(groups: TableGroup[]): Promise<void> {
    await this.tracked('Pushing the database', false, async (ctx, dir) => {
      const r = await pushDatabase(ctx, dir, groups);
      if (this.view.view === 'tracking' && this.here(dir)) this.view = { ...this.view, lastBackup: r.backup.path };
      this.notice = { kind: 'success', text: `Pushed ${r.tables.length} table(s). The live database was backed up first; you can roll back.` };
      this.emit();
    });
  }

  // ---- helpers ------------------------------------------------------------

  private async ddevInstalled(): Promise<string | null> {
    // Only a found DDEV is remembered, so installing it later is picked up without a restart.
    this.ddevVersion ??= await this.deps.ddev.version();
    return this.ddevVersion;
  }

  private async ddevInfo(dir: string): Promise<DdevInfo> {
    if ((await this.ddevInstalled()) === null) return { status: 'not-installed' };
    const d = await this.deps.ddev.describe(dir);
    return { status: d.status, url: d.url, mailpitUrl: d.mailpitUrl };
  }

  private async rememberHostLabel(host: SshHostInfo): Promise<void> {
    const labels = (await this.deps.host.storageGet<Record<string, string>>(HOST_LABELS_KEY)) ?? {};
    labels[host.id] = host.label;
    await this.deps.host.storageSet(HOST_LABELS_KEY, labels);
  }

  private async hostLabel(hostId: string): Promise<string | undefined> {
    try {
      const live = (await this.deps.host.listSshHosts()).find((h) => h.id === hostId);
      if (live) return live.label;
    } catch (err) {
      if (!isOrcaApiPending(err)) throw err;
    }
    return (await this.deps.host.storageGet<Record<string, string>>(HOST_LABELS_KEY))?.[hostId];
  }

  dispose(): void {
    this.abort?.abort();
    for (const { session } of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
