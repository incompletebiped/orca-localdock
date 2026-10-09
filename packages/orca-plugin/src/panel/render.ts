import type { ChangeRow, GapInfo, HostSummary, PanelState, SideChange, SiteSummary, TableGroupOption } from '../shared/protocol.js';

/** Panel-only UI state that the worker doesn't need to know about. */
export interface UiState {
  selected: Set<string>;
  filter: string;
  includeUploads: boolean;
  dbOpen: boolean;
  dbGroups: Set<string>;
  /** A destructive action waiting for an inline confirmation (the sandbox blocks confirm() dialogs). */
  confirming: { action: string; text: string } | null;
}

export function newUiState(): UiState {
  return { selected: new Set(), filter: '', includeUploads: false, dbOpen: false, dbGroups: new Set(), confirming: null };
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML. Every string from the server or worker goes through this. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** A button that dispatches `action` (JSON, escaped into an attribute). */
function button(label: string, action: object | string, opts: { primary?: boolean; danger?: boolean; disabled?: boolean; title?: string } = {}): string {
  const data = typeof action === 'string' ? action : JSON.stringify(action);
  const cls = ['btn', opts.primary ? 'btn-primary' : '', opts.danger ? 'btn-danger' : ''].filter(Boolean).join(' ');
  return `<button class="${cls}" data-action="${esc(data)}"${opts.disabled ? ' disabled' : ''}${opts.title ? ` title="${esc(opts.title)}"` : ''}>${esc(label)}</button>`;
}

function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function render(state: PanelState, ui: UiState): string {
  return [renderNotice(state), renderJob(state), renderConfirm(ui), `<main>${renderView(state, ui)}</main>`].join('');
}

function renderConfirm(ui: UiState): string {
  if (!ui.confirming) return '';
  return `<div class="notice notice-error confirm" role="alertdialog"><span>${esc(ui.confirming.text)}</span>
    <button class="btn btn-danger" data-confirm="yes">Confirm</button><button class="btn" data-confirm="no">Cancel</button></div>`;
}

function renderNotice(state: PanelState): string {
  if (!state.notice) return '';
  return `<div class="notice notice-${esc(state.notice.kind)}" role="status"><span>${esc(state.notice.text)}</span>${button('×', { type: 'dismiss-notice' }, { title: 'Dismiss' })}</div>`;
}

function renderJob(state: PanelState): string {
  const job = state.job;
  if (!job) return '';
  const pct = job.total ? Math.round(((job.current ?? 0) / job.total) * 100) : null;
  return `<div class="job" role="progressbar"${pct !== null ? ` aria-valuenow="${pct}"` : ''}>
    <div class="job-text"><strong>${esc(job.title)}</strong><span>${esc(job.message)}</span></div>
    <div class="bar"><div class="bar-fill${pct === null ? ' indeterminate' : ''}" style="width:${pct ?? 30}%"></div></div>
    ${job.cancellable ? button('Cancel', { type: 'cancel' }) : ''}
  </div>`;
}

function renderView(state: PanelState, ui: UiState): string {
  switch (state.view) {
    case 'loading':
      return `<p class="muted">Loading…</p>`;
    case 'awaiting-orca':
      return renderAwaitingOrca(state.gaps, state.blockedAction);
    case 'no-project':
      return empty('No project open', 'Create or open a project in Orca, then come back here. LocalDock pulls a WordPress site into an empty project.');
    case 'project-not-empty':
      return empty(
        'This project already has files',
        `LocalDock pulls a WordPress site into a new, empty project, so “${state.projectName}” can’t take one. Create an empty project in Orca, open it, then check again.`,
        button('Check again', { type: 'refresh' }, { primary: true }),
      );
    case 'no-hosts':
      return empty(
        'Connect a cPanel server',
        'Add an SSH host in Orca (Settings → SSH) that points at a cPanel server. Log in as root to see every account, or as a cPanel account user to see that account’s sites.',
        button('Check again', { type: 'refresh' }, { primary: true }),
      );
    case 'choose-host':
      return renderHosts(state.hosts);
    case 'scanning':
      return `<h2>${esc(state.host.label)}</h2><p class="muted">Scanning for WordPress sites…</p>`;
    case 'site-list':
      return renderSites(state.host, state.sites, state.projectEmpty, ui);
    case 'pulling':
      return `<h2>Pulling ${esc(state.site.domain)}</h2><p class="muted">From ${esc(state.host.label)} into this project. Files first, then the database, then DDEV starts the site.</p>`;
    case 'tracking':
      return renderTracking(state, ui);
    case 'error':
      return empty('Something went wrong', state.message, button('Try again', { type: 'refresh' }, { primary: true }));
  }
}

function empty(title: string, text: string, actions = ''): string {
  return `<section class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${actions}</section>`;
}

export function renderAwaitingOrca(gaps: GapInfo[], blockedAction?: string): string {
  return `<section class="empty">
    <h2>Waiting on Orca</h2>
    <p>LocalDock is a work in progress. ${blockedAction ? `This step (<code>${esc(blockedAction)}</code>) needs` : 'It needs'} a capability Orca plugins don't have yet:</p>
    <ul class="gaps">${gaps.map((g) => `<li><strong>${esc(g.title)}</strong><br><span class="muted">${esc(g.need)}</span></li>`).join('')}</ul>
    <p class="muted">Details: github.com/incompletebiped/orca-localdock › docs/ORCA-GAPS.md</p>
    ${button('Check again', { type: 'refresh' })}
  </section>`;
}

function renderHosts(hosts: HostSummary[]): string {
  return `<h2>Choose a server</h2>
  <p class="muted">SSH hosts from Orca. LocalDock lists the WordPress sites on the cPanel server behind each one.</p>
  <ul class="list">${hosts
    .map(
      (h) => `<li class="row">
        <span class="dot ${h.connected ? 'dot-on' : 'dot-off'}" title="${h.connected ? 'Connected' : 'Not connected'}"></span>
        <span class="grow"><strong>${esc(h.label)}</strong><br><span class="muted small">${esc(h.detail)}</span></span>
        ${h.connected ? button('Scan for sites', { type: 'scan-sites', hostId: h.id }, { primary: true }) : button('Connect', { type: 'connect-host', hostId: h.id }, { primary: true })}
      </li>`,
    )
    .join('')}</ul>`;
}

function renderSites(host: HostSummary, sites: SiteSummary[], projectEmpty: boolean, ui: UiState): string {
  const f = ui.filter.trim().toLowerCase();
  const visible = f ? sites.filter((s) => s.domain.includes(f) || s.account.includes(f) || s.aliases.some((a) => a.includes(f))) : sites;
  const byAccount = new Map<string, SiteSummary[]>();
  for (const s of visible) byAccount.set(s.account, [...(byAccount.get(s.account) ?? []), s]);
  return `<div class="toolbar">${button('‹ Servers', { type: 'back-to-hosts' })}<span class="grow"></span>${button('Rescan', { type: 'scan-sites', hostId: host.id })}</div>
  <h2>${esc(host.label)}</h2>
  <p class="muted small">${sites.length} WordPress site${sites.length === 1 ? '' : 's'} found.</p>
  ${projectEmpty ? '' : `<p class="notice notice-info">This project isn't empty. Create a new, empty project to pull a site into.</p>`}
  <input class="input" type="search" placeholder="Filter sites" value="${esc(ui.filter)}" data-ui="filter">
  <label class="check"><input type="checkbox" data-ui="includeUploads"${ui.includeUploads ? ' checked' : ''}> Also download media uploads</label>
  ${[...byAccount]
    .map(
      ([account, list]) => `<h3>${esc(account)}</h3><ul class="list">${list
        .map(
          (s) => `<li class="row">
            <span class="grow"><strong>${esc(s.domain)}</strong><br><span class="muted small">WordPress ${esc(s.wpVersion)}${s.aliases.length ? ` · also ${esc(s.aliases.join(', '))}` : ''}</span></span>
            ${button('Pull', { type: 'pull-site', hostId: host.id, account: s.account, domain: s.domain, includeUploads: ui.includeUploads }, { primary: true, disabled: !projectEmpty })}
          </li>`,
        )
        .join('')}</ul>`,
    )
    .join('') || `<p class="muted">No sites match.</p>`}`;
}

const LETTER: Record<SideChange, string> = { added: 'A', modified: 'M', deleted: 'D', unchanged: '' };

function changeList(rows: ChangeRow[], side: 'local' | 'remote', ui: UiState): string {
  return `<ul class="changes">${rows
    .map((r) => {
      const change = r[side];
      const name = r.path.split('/').pop() ?? r.path;
      const dir = r.path.slice(0, r.path.length - name.length).replace(/\/$/, '');
      return `<li class="change" title="${esc(r.path)}">
        <input type="checkbox" data-select="${esc(r.path)}"${ui.selected.has(r.path) ? ' checked' : ''} aria-label="Select ${esc(r.path)}">
        <span class="name">${esc(name)}</span><span class="dir muted">${esc(dir)}</span>
        <span class="letter letter-${esc(change)}">${LETTER[change]}</span>
      </li>`;
    })
    .join('')}</ul>`;
}

function section(title: string, count: number, body: string, actions: string): string {
  return `<details class="section" open><summary><span class="grow">${esc(title)}</span><span class="badge">${count}</span></summary>
    ${count ? `${body}<div class="section-actions">${actions}</div>` : `<p class="muted small pad">Nothing here.</p>`}</details>`;
}

function renderTracking(state: Extract<PanelState, { view: 'tracking' }>, ui: UiState): string {
  const { site, ddev, changes } = state;
  const running = ddev.status === 'running';
  const busy = Boolean(state.job);
  const ddevLine =
    ddev.status === 'not-installed'
      ? `<p class="notice notice-info">Install <strong>DDEV</strong> to run this site locally (ddev.com).</p>`
      : ddev.status === 'docker-not-running'
        ? `<div class="notice notice-info"><span>Docker isn’t running, so the local site can’t start.</span>${button('Start Docker Desktop', { type: 'start-docker' }, { primary: true, disabled: busy })}${button('Check again', { type: 'refresh' }, { disabled: busy })}</div>`
        : `<div class="ddev">
          <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
          <span class="grow">${running ? `Running at <code>${esc(ddev.url ?? '')}</code>` : `Local site ${esc(ddev.status.replace('-', ' '))}`}</span>
          ${running ? button('■ Stop', { type: 'stop' }, { disabled: busy }) : button('▶ Start', { type: 'start' }, { primary: true, disabled: busy })}
        </div>
        <div class="links">
          ${button('Site', { type: 'open', target: 'site' }, { disabled: !running })}
          ${button('WP Admin', { type: 'open', target: 'admin' }, { disabled: !running })}
          ${button('Mailpit', { type: 'open', target: 'mailpit' }, { disabled: !running })}
          ${button('Live site', { type: 'open', target: 'live' })}
        </div>`;

  const rows = changes?.rows ?? [];
  const push = rows.filter((r) => r.direction === 'push');
  const pull = rows.filter((r) => r.direction === 'pull');
  const conflicts = rows.filter((r) => r.direction === 'conflict');
  const selectedOf = (list: ChangeRow[]) => list.filter((r) => ui.selected.has(r.path)).map((r) => r.path);
  const allOf = (list: ChangeRow[]) => list.map((r) => r.path);

  const changeSections = changes
    ? [
        section('Local changes', push.length, changeList(push, 'local', ui),
          button('Push selected', { type: 'push-files', paths: selectedOf(push) }, { primary: true, disabled: busy || selectedOf(push).length === 0 }) +
          button('Push all', { type: 'push-files', paths: allOf(push) }, { disabled: busy })),
        section('Server changes', pull.length, changeList(pull, 'remote', ui),
          button('Pull selected', { type: 'pull-files', paths: selectedOf(pull) }, { disabled: busy || selectedOf(pull).length === 0 }) +
          button('Pull all', { type: 'pull-files', paths: allOf(pull) }, { disabled: busy })),
        section('Changed on both sides', conflicts.length, changeList(conflicts, 'local', ui),
          button('Keep local (push)', { type: 'push-files', paths: selectedOf(conflicts), allowConflicts: true }, { danger: true, disabled: busy || selectedOf(conflicts).length === 0 }) +
          button('Take server (pull)', { type: 'pull-files', paths: selectedOf(conflicts), allowConflicts: true }, { danger: true, disabled: busy || selectedOf(conflicts).length === 0 })),
      ].join('')
    : `<p class="muted small pad">Check for changes to compare this project with the live site.</p>`;

  return `<header class="site">
      <h2>${esc(site.domain)}</h2>
      <p class="muted small">${esc(site.hostLabel)} · ${esc(site.account)} · pulled ${esc(timeAgo(site.pulledAt))}${site.lastPushedAt ? ` · pushed ${esc(timeAgo(site.lastPushedAt))}` : ''}</p>
    </header>
    ${ddevLine}
    <div class="toolbar">${button('⟳ Check for changes', { type: 'scan-changes' }, { primary: true, disabled: busy })}<span class="grow"></span><span class="muted small">${changes ? `checked ${esc(timeAgo(changes.scannedAt))}` : ''}</span></div>
    ${changeSections}
    ${renderDatabase(state.dbGroups, state.lastBackup, ui, busy)}`;
}

function renderDatabase(groups: TableGroupOption[] | null, lastBackup: string | undefined, ui: UiState, busy: boolean): string {
  const chosen = groups ? groups.filter((g) => ui.dbGroups.has(g.id)).map((g) => g.id) : [];
  const picker = !ui.dbOpen
    ? ''
    : !groups
      ? `<p class="muted small pad">Loading table groups…</p>`
      : `<div class="pad">
          ${groups
            .map(
              (g) => `<label class="check"><input type="checkbox" data-dbgroup="${esc(g.id)}"${ui.dbGroups.has(g.id) ? ' checked' : ''}>
                <span><strong>${esc(g.label)}</strong> <span class="muted small">(${g.tables} table${g.tables === 1 ? '' : 's'})</span><br><span class="muted small">${esc(g.description)}</span></span></label>`,
            )
            .join('')}
          <p class="muted small">The live database is backed up on the server before anything is overwritten.</p>
          ${button('Push selected tables', { type: 'push-db', groups: chosen }, { danger: true, disabled: busy || chosen.length === 0 })}
        </div>`;
  return `<details class="section"${ui.dbOpen ? ' open' : ''} data-ui="dbOpen"><summary><span class="grow">Database</span></summary>
    <div class="section-actions">
      ${button('Pull live database', { type: 'pull-db' }, { disabled: busy, title: 'Replace the local database with a copy of the live one' })}
      ${ui.dbOpen ? '' : button('Push database…', 'open-db')}
      ${lastBackup ? button('Roll back last push', { type: 'rollback-db', backupPath: lastBackup }, { danger: true, disabled: busy }) : ''}
    </div>
    ${picker}
  </details>`;
}
