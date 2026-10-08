import { describe, it, expect } from 'vitest';
import { esc, newUiState, render } from '../src/panel/render.js';
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

  it('groups changes like Source Control and enables push for selected files', () => {
    const ui = newUiState();
    ui.selected.add('wp-content/themes/example-child/style.css');
    const html = render(FIXTURES['Source control']!, ui);
    expect(html).toContain('Local changes');
    expect(html).toContain('Server changes');
    expect(html).toContain('Changed on both sides');
    expect(html).toMatch(/push-files[^>]*style\.css/);
    expect(html).toContain('■ Stop');
  });

  it('shows an inline confirmation instead of a dialog (the panel sandbox blocks confirm())', () => {
    const ui = newUiState();
    ui.confirming = { action: '{"type":"push-db","groups":["content"]}', text: 'Overwrite the LIVE site?' };
    expect(render(FIXTURES['Source control']!, ui)).toContain('data-confirm="yes"');
  });

  it('escapes the basics', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
