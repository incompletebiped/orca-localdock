import { GAPS } from '../shared/gaps.js';
import type { PanelState } from '../shared/protocol.js';

/** Sample states for the browser preview and render tests. Example hosts and domains only. */
const base = { revision: 1, job: null, notice: null } as const;

const host = { id: 'h1', label: 'Example cPanel server', detail: 'root@server.example.com', connected: true };

const sites = [
  { account: 'exampleco', domain: 'example.com', docroot: '/home/exampleco/public_html', wpVersion: '6.8.1', aliases: ['www.example.com'] },
  { account: 'exampleco', domain: 'shop.example.com', docroot: '/home/exampleco/shop', wpVersion: '6.8.1', aliases: [] },
  { account: 'demoacct', domain: 'example.org', docroot: '/home/demoacct/public_html', wpVersion: '6.7.2', aliases: [] },
];

export const FIXTURES: Record<string, PanelState> = {
  'Waiting on Orca': { ...base, view: 'awaiting-orca', gaps: [GAPS['panel-bridge'], GAPS['project-path'], GAPS['ssh-hosts'], GAPS['ssh-session']] },
  'No project': { ...base, view: 'no-project' },
  'Project not empty': { ...base, view: 'project-not-empty', projectName: 'my-app' },
  'No SSH hosts': { ...base, view: 'no-hosts' },
  'Choose a server': {
    ...base,
    view: 'choose-host',
    hosts: [host, { id: 'h2', label: 'Staging server', detail: 'deploy@203.0.113.20:2222', connected: false }],
  },
  'Scanning': { ...base, view: 'scanning', host, job: { title: 'Scanning for WordPress sites', message: 'Checked 1 of 2 account(s)…', cancellable: false } },
  'Site list': { ...base, view: 'site-list', host, sites, projectEmpty: true },
  'Pulling': {
    ...base,
    view: 'pulling',
    host,
    site: sites[0]!,
    job: { title: 'Pulling example.com', message: 'Downloading files… (1204/3311)', current: 1204, total: 3311, cancellable: true },
  },
  'Source control': {
    ...base,
    view: 'tracking',
    site: {
      domain: 'example.com',
      productionUrl: 'https://example.com',
      account: 'exampleco',
      hostId: 'h1',
      hostLabel: 'Example cPanel server',
      pulledAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    },
    ddev: { status: 'running', url: 'https://example-com.ddev.site', mailpitUrl: 'https://example-com.ddev.site:8026' },
    changes: {
      scannedAt: new Date(Date.now() - 60_000).toISOString(),
      rows: [
        { path: 'wp-content/themes/example-child/style.css', local: 'modified', remote: 'unchanged', direction: 'push' },
        { path: 'wp-content/themes/example-child/functions.php', local: 'modified', remote: 'unchanged', direction: 'push' },
        { path: 'wp-content/themes/example-child/templates/hero.php', local: 'added', remote: 'unchanged', direction: 'push' },
        { path: 'wp-content/plugins/contact-form-7/readme.txt', local: 'unchanged', remote: 'modified', direction: 'pull' },
        { path: 'wp-content/plugins/old-plugin/old.php', local: 'unchanged', remote: 'deleted', direction: 'pull' },
        { path: 'wp-content/themes/example-child/header.php', local: 'modified', remote: 'modified', direction: 'conflict' },
      ],
    },
    dbGroups: null,
  },
  'Source control (stopped, DB open)': {
    ...base,
    view: 'tracking',
    site: {
      domain: 'example.com',
      productionUrl: 'https://example.com',
      account: 'exampleco',
      hostId: 'h1',
      hostLabel: 'Example cPanel server',
      pulledAt: new Date(Date.now() - 86400_000 * 2).toISOString(),
      lastPushedAt: new Date(Date.now() - 600_000).toISOString(),
    },
    ddev: { status: 'stopped' },
    changes: null,
    dbGroups: [
      { id: 'content', label: 'Content', description: 'Posts, pages, custom post types, menus, categories and tags', tables: 7, pushByDefault: true },
      { id: 'config', label: 'Settings', description: 'Site options, theme and plugin settings (wp_options)', tables: 1, pushByDefault: true },
      { id: 'users', label: 'Users', description: 'User accounts and profiles', tables: 2, pushByDefault: false },
      { id: 'commerce', label: 'Store & forms', description: 'WooCommerce orders and customers, form entries, scheduled actions', tables: 14, pushByDefault: false },
    ],
    lastBackup: '/home/exampleco/.localdock-backups/example_db-2026-10-08T12-00-00-000Z.sql.gz',
    notice: { kind: 'success', text: 'Pushed 8 table(s). The live database was backed up first; you can roll back.' },
  },
  'DDEV not installed': {
    ...base,
    view: 'tracking',
    site: { domain: 'example.org', productionUrl: 'https://example.org', account: 'demoacct', hostId: 'h1', hostLabel: 'Example cPanel server', pulledAt: new Date().toISOString() },
    ddev: { status: 'not-installed' },
    changes: { scannedAt: new Date().toISOString(), rows: [] },
    dbGroups: null,
  },
};
