import { describe, it, expect } from 'vitest';
import { GROUP_ROWS, esc, newUiState, render } from '../src/panel/render.js';
import { FIXTURES } from '../src/preview/fixtures.js';
import type { PanelState } from '../src/shared/protocol.js';

describe('panel rendering', () => {
  it('renders every sample state', () => {
    for (const [name, state] of Object.entries(FIXTURES)) {
      expect(render(state, newUiState()), name).toContain('<main>');
    }
  });

  it('escapes server-supplied text so a hostile site name cannot inject markup', () => {
    const evil = `<img src=x onerror="parent.postMessage({type:'orca-panel-action',action:'terminal.sendText'},'*')">`;
    const state: PanelState = {
      revision: 1, job: null, notice: { kind: 'error', text: evil },
      view: 'site-list',
      host: { id: 'h', label: evil, detail: evil, connected: true },
      projectEmpty: true,
      sites: [{ account: 'a', domain: evil, docroot: '/x', wpVersion: evil, aliases: [evil] }],
    };
    const html = render(state, newUiState());
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;');
  });

  it('puts actions in escaped data attributes', () => {
    const html = render(FIXTURES['Site list']!, newUiState());
    const m = html.match(/data-action="([^"]*pull-site[^"]*)"/);
    expect(m).not.toBeNull();
    const decoded = m![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    expect(JSON.parse(decoded)).toMatchObject({ type: 'pull-site', hostId: 'h1', domain: 'example.com', includeUploads: false });
  });

  it('disables Pull when the project is not empty', () => {
    const html = render({ ...(FIXTURES['Site list'] as Extract<PanelState, { view: 'site-list' }>), projectEmpty: false }, newUiState());
    expect(html).toContain("This project isn't empty");
    expect(html).toMatch(/pull-site[^>]*disabled/);
  });

  it('offers Resume only for a pull this computer can resume, and Start over either way', () => {
    const state = FIXTURES['Pull interrupted'] as Extract<PanelState, { view: 'pull-interrupted' }>;
    const html = render(state, newUiState());
    expect(html).toContain('resume-pull');
    expect(html).toContain('discard-pull');
    expect(html).toContain('2140 files already here');
    const orphan = render({ ...state, canResume: false, hostLabel: null }, newUiState());
    expect(orphan).not.toContain('resume-pull');
    expect(orphan).toContain('no record of which server');
  });

  it('groups changes like Source Control and enables push for selected files', () => {
    const ui = newUiState();
    ui.selected.add('wp-content/themes/example-child/style.css');
    const html = render(FIXTURES['Source control']!, ui);
    expect(html).toContain('Local changes');
    expect(html).toContain('Server changes');
    expect(html).toContain('Changed on both sides');
    expect(html).toMatch(/data-select-action="push"(?![^>]*disabled)/);
    expect(html).toContain('theme example-child');
    expect(html).toContain('■ Stop');
    expect(html).toMatch(/class="link" data-action="[^"]*&quot;open&quot;[^"]*&quot;site&quot;/);
  });

  it('groups long change lists by core, plugin and theme, drawing rows only for open groups', () => {
    const base = FIXTURES['Source control'] as Extract<PanelState, { view: 'tracking' }>;
    const rows = [
      ...Array.from({ length: 1200 }, (_, i) => ({ path: `wp-includes/file-${i}.php`, local: 'unchanged' as const, remote: 'modified' as const, direction: 'pull' as const })),
      ...Array.from({ length: 300 }, (_, i) => ({ path: `wp-content/plugins/example-forms/f${i}.php`, local: 'unchanged' as const, remote: 'added' as const, direction: 'pull' as const })),
    ];
    const state: PanelState = { ...base, changes: { rows, serverCheckedAt: base.changes!.serverCheckedAt } };
    const ui = newUiState();
    let html = render(state, ui);
    expect(html).toContain('WordPress core');
    expect(html).toContain('plugin example-forms');
    expect(html.indexOf('WordPress core')).toBeLessThan(html.indexOf('plugin example-forms'));
    expect(html).not.toContain('data-select="wp-includes/'); // closed by default: no rows drawn
    expect(html).toContain('data-group-action="pull|*"'); // "Pull all" names a group, not 1,500 paths
    expect(html.length).toBeLessThan(20_000);

    ui.toggledGroups.add('pull|WordPress core');
    html = render(state, ui);
    expect(html.match(/data-select="wp-includes\//g)).toHaveLength(GROUP_ROWS);
    expect(html).toContain('Show all 1200');
    ui.showAll.add('pull|WordPress core');
    expect(render(state, ui).match(/data-select="wp-includes\//g)).toHaveLength(1200);
  });

  it('greys out the steps that need the server when it can’t be reached, and says why', () => {
    const html = render(FIXTURES['Source control (no SSH yet)']!, newUiState());
    expect(html).toContain('Server steps are off');
    for (const marker of ['scan-changes', 'pull-db', 'data-group-action="push|*"', 'data-group-action="pull|*"', 'data-group-action="pull|plugin contact-form-7"']) {
      expect(html, marker).toMatch(new RegExp(`${marker.replace(/[|*]/g, '\\$&')}[^>]*disabled`));
    }
    expect(html).toMatch(/open-db[^>]*disabled/);
    expect(html).not.toMatch(/&quot;start&quot;[^>]*disabled|&quot;stop&quot;[^>]*disabled/);
    expect(render(FIXTURES['Source control']!, newUiState())).not.toContain('Server steps are off');
  });

  it('shows an inline confirmation instead of a dialog (the panel sandbox blocks confirm())', () => {
    const ui = newUiState();
    ui.confirming = { action: '{"type":"push-db","groups":["content"]}', text: 'Overwrite the LIVE site?' };
    expect(render(FIXTURES['Source control']!, ui)).toContain('data-confirm="yes"');
  });

  it('greys out the change lists while a job runs and marks the files being synced', () => {
    const html = render(FIXTURES['Source control (pulling)']!, newUiState());
    expect(html).toContain('changes-busy');
    expect(html).toMatch(/data-group-action="pull\|\*"[^>]*disabled/);
    expect(html).toMatch(/data-select="wp-content\/themes\/example-child\/style\.css" disabled/);
    expect(html.match(/change-syncing/g)).toHaveLength(2);
    expect(html).toContain('↓');
  });

  it("puts a section's buttons above its file list", () => {
    const html = render(FIXTURES['Source control']!, newUiState());
    const server = html.slice(html.indexOf('Server changes'));
    expect(server.indexOf('Pull all')).toBeLessThan(server.indexOf('<li class="change'));
  });

  it('escapes the basics', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
