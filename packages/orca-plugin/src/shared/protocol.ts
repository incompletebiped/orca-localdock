/**
 * Messages between the panel (sandboxed iframe) and the plugin worker.
 *
 * The panel renders a PanelState snapshot and sends PanelActions back. Orca
 * 1.4.222 has no channel for either direction yet (see docs/ORCA-GAPS.md,
 * gap "panel-bridge"); this protocol is what the channel will carry. Actions
 * are validated in the worker (actionSchema.ts) because nothing from the panel
 * is trusted. This file holds types only, so the panel bundle stays small.
 */
export type GapId = 'panel-bridge' | 'project-path' | 'ssh-hosts' | 'ssh-session' | 'open-url';

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

export type DdevStatus = 'not-installed' | 'not-configured' | 'stopped' | 'starting' | 'running' | 'paused' | 'unhealthy' | 'unknown';

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
      changes: { rows: ChangeRow[]; scannedAt: string } | null;
      dbGroups: TableGroupOption[] | null;
      lastBackup?: string;
    }
  | { view: 'error'; message: string };

export type PanelState = PanelView & {
  /** Increases on every change, so the panel can skip identical snapshots. */
  revision: number;
  job: Job | null;
  notice: Notice | null;
};

export type { PanelAction, PanelActionInput } from './actionSchema.js';

/** Command ids the panel will call once Orca lets panels invoke their own worker. */
export const COMMAND_STATE = 'localdock.state';
export const COMMAND_DISPATCH = 'localdock.dispatch';
