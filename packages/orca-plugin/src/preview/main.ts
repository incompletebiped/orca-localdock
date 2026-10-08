/**
 * Browser preview of the panel with sample states. Not shipped in the plugin.
 * Pick a state from the menu; actions are echoed in the log instead of running.
 */
import { mountPanel } from '../panel/app.js';
import type { PanelBridge } from '../panel/bridge.js';
import type { PanelActionInput, PanelState } from '../shared/protocol.js';
import { FIXTURES } from './fixtures.js';

const names = Object.keys(FIXTURES);
const params = new URLSearchParams(location.hash.slice(1));
let current: PanelState = FIXTURES[params.get('state') ?? names[0]!] ?? FIXTURES[names[0]!]!;

const select = document.getElementById('state') as HTMLSelectElement;
select.innerHTML = names.map((n) => `<option${FIXTURES[n] === current ? ' selected' : ''}>${n}</option>`).join('');
select.addEventListener('change', () => {
  location.hash = `state=${encodeURIComponent(select.value)}`;
  location.reload();
});

const log = document.getElementById('log')!;
const bridge: PanelBridge = {
  getState: async () => current,
  dispatch: async (action: PanelActionInput) => {
    log.textContent = `dispatch → ${JSON.stringify(action)}\n` + log.textContent;
    if (action.type === 'dismiss-notice') current = { ...current, notice: null, revision: current.revision + 1 };
    return current;
  },
};

mountPanel(document.getElementById('app')!, bridge);
