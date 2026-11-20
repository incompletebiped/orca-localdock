/**
 * Messages between the panel (sandboxed iframe) and the plugin worker.
 *
 * The panel asks the worker with Orca's `plugin.request` (REQUEST_STATE,
 * REQUEST_DISPATCH), and the worker pushes each new PanelState with
 * `orca.panels.post` (EVENT_STATE). Actions are validated in the worker
 * (actionSchema.ts) because nothing from the panel is trusted. This file holds
 * types and constants only, so the panel bundle stays small.
 */
export type GapId = 'ssh-hosts' | 'ssh-session';

export interface GapInfo {
  id: GapId;
  title: string;
  /** What LocalDock needs from Orca, in one sentence. */
  need: string;
}

export interface HostSummary {
  id: string;
  label: string;
  /** e.g. `root@server.example.com` */
  detail: string;
  connected: boolean;
}

export interface SiteSummary {
  account: string;
  domain: string;
  docroot: string;
  wpVersion: string;
  aliases: string[];
}

export type SideChange = 'unchanged' | 'added' | 'modified' | 'deleted';
export type Direction = 'push' | 'pull' | 'conflict' | 'same';

export interface ChangeRow {
  path: string;
  local: SideChange;
  remote: SideChange;
  direction: Direction;
}

export type DdevStatus = 'not-installed' | 'docker-not-running' | 'not-configured' | 'stopped' | 'starting' | 'running' | 'paused' | 'unhealthy' | 'unknown';

export interface DdevInfo {
  status: DdevStatus;
  url?: string;
  mailpitUrl?: string;
}

export interface Job {
  title: string;
  message: string;
  current?: number;
  total?: number;
  cancellable: boolean;
}

export interface Notice {
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface TableGroupOption {
  id: 'content' | 'config' | 'users' | 'comments' | 'commerce' | 'plugins' | 'other';
  label: string;
  description: string;
  tables: number;
  pushByDefault: boolean;
}

export interface TrackedSite {
  domain: string;
  productionUrl: string;
  account: string;
  hostId: string;
  hostLabel: string;
  pulledAt: string;
  lastPushedAt?: string;
}

export type PanelView =
  | { view: 'loading' }
  /** An Orca capability LocalDock needs isn't available yet. */
  | { view: 'awaiting-orca'; gaps: GapInfo[]; blockedAction?: string }
  | { view: 'no-project' }
  /** The focused project lives on an SSH host or another Orca; DDEV runs sites on this computer only. */
  | { view: 'remote-project'; projectName: string }
  /** An empty project LocalDock hasn't been asked to use yet. */
  | { view: 'set-up'; projectName: string }
  /** The open project already has files, so it can't take a pulled site. */
  | { view: 'project-not-empty'; projectName: string }
  /** No SSH hosts in Orca yet. */
  | { view: 'no-hosts' }
  | { view: 'choose-host'; hosts: HostSummary[] }
  | { view: 'scanning'; host: HostSummary }
  | { view: 'site-list'; host: HostSummary; sites: SiteSummary[]; projectEmpty: boolean }
  | { view: 'pulling'; host: HostSummary; site: SiteSummary }
  | {
      view: 'tracking';
      site: TrackedSite;
      ddev: DdevInfo;
      /** Local changes are always current; server changes are as of the last check (null: never checked). */
      changes: { rows: ChangeRow[]; serverCheckedAt: string | null } | null;
      dbGroups: TableGroupOption[] | null;
      lastBackup?: string;
      /** No DDEV site and no other container is running, so Docker Desktop could be quit. */
      dockerIdle?: boolean;
      /** Why steps that need the server can't run here, or absent when they can. */
      serverBlocked?: string;
    }
  | { view: 'error'; message: string };

export type PanelState = PanelView & {
  /** Increases on every change, so the panel can skip identical snapshots. */
  revision: number;
  job: Job | null;
  notice: Notice | null;
};

export type { PanelAction, PanelActionInput } from './actionSchema.js';

export type LinkTarget = 'site' | 'admin' | 'mailpit' | 'live';

/**
 * A link button. The panel asks the worker to open it in Orca's browser
 * (REQUEST_OPEN), and opens the default browser itself if that fails, since
 * Orca only opens an outside URL from a click in the panel's own frame.
 */
export interface OpenLink {
  type: 'open';
  target: LinkTarget;
}

/** The URL a link button opens, or null when the local site isn't running yet. */
export function linkUrl(view: PanelView, target: LinkTarget): string | null {
  if (view.view !== 'tracking') return null;
  const { ddev, site } = view;
  if (target === 'live') return site.productionUrl;
  if (target === 'mailpit') return ddev.mailpitUrl ?? null;
  if (!ddev.url) return null;
  return target === 'admin' ? `${ddev.url.replace(/\/$/, '')}/wp-admin/` : ddev.url;
}

/** `plugin.request` names the worker answers with `orca.panels.handle`. */
export const REQUEST_STATE = 'state';
export const REQUEST_DISPATCH = 'dispatch';
/** Input `{ target: LinkTarget }`, answer OpenLinkResult. */
export const REQUEST_OPEN = 'open';

/** `opened: false` with a URL: Orca's browser wasn't reachable, so the panel opens the default browser. */
export interface OpenLinkResult {
  opened: boolean;
  url: string | null;
}
/** Worker → panel push (`orca.panels.post`): the full PanelState. */
export const EVENT_STATE = 'state';
/** Worker → panel push when the state is too large to post: the panel asks for it instead. */
export const EVENT_STALE = 'state.stale';
