import { GAPS } from '../shared/gaps.js';
import type { PanelActionInput, PanelState } from '../shared/protocol.js';
import { BridgeUnavailableError, type PanelBridge } from './bridge.js';
import { newUiState, render, type UiState } from './render.js';

const POLL_BUSY_MS = 1000;
const POLL_IDLE_MS = 5000;

/**
 * Wires the rendered panel to a bridge: clicks become actions, and state is
 * polled (Orca allows 30 panel messages per 10 s, so polling stays well
 * under that).
 */
export function mountPanel(root: HTMLElement, bridge: PanelBridge): void {
  const ui: UiState = newUiState();
  let state: PanelState = { view: 'loading', revision: 0, job: null, notice: null };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const paint = () => {
    const focusedUi = (document.activeElement as HTMLElement | null)?.dataset['ui'];
    root.innerHTML = render(state, ui);
    if (focusedUi) {
      const el = root.querySelector<HTMLInputElement>(`[data-ui="${focusedUi}"]`);
      el?.focus();
      if (el && 'value' in el) el.setSelectionRange?.(el.value.length, el.value.length);
    }
  };

  const unavailable = (err: unknown) => {
    state = { view: 'awaiting-orca', gaps: [GAPS['panel-bridge']], revision: state.revision, job: null, notice: null };
    if (!(err instanceof BridgeUnavailableError)) state.notice = { kind: 'error', text: String((err as Error)?.message ?? err) };
    paint();
  };

  const accept = (next: PanelState) => {
    if (next.revision !== state.revision || next.view !== state.view) {
      if (next.view !== state.view) ui.selected.clear();
      state = next;
      paint();
    }
    schedule();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void bridge.getState().then(accept, unavailable), state.job ? POLL_BUSY_MS : POLL_IDLE_MS);
  };

  const send = (action: PanelActionInput) => {
    if (action.type === 'load-db-groups') ui.dbOpen = true;
    void bridge.dispatch(action).then(accept, unavailable);
    // Poll quickly while the action runs, so progress shows up.
    clearTimeout(timer);
    timer = setTimeout(() => void bridge.getState().then(accept, unavailable), POLL_BUSY_MS);
  };

  /** Text for actions that need an inline confirmation first. */
  const confirmText = (action: PanelActionInput): string | null => {
    if (action.type === 'push-db') return 'Overwrite the selected tables on the LIVE site? A backup is taken first.';
    if (action.type === 'rollback-db') return 'Restore the live database to the backup taken before the last push?';
    if ((action.type === 'push-files' || action.type === 'pull-files') && action.allowConflicts) {
      return 'These files changed on both sides. Overwrite the other side’s version?';
    }
    return null;
  };

  root.addEventListener('click', (e) => {
    const answer = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-confirm]');
    if (answer && ui.confirming) {
      const pending = ui.confirming.action;
      ui.confirming = null;
      paint();
      if (answer.dataset['confirm'] === 'yes') send(JSON.parse(pending) as PanelActionInput);
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!btn || btn.disabled) return;
    const raw = btn.dataset['action']!;
    if (raw === 'open-db') {
      ui.dbOpen = true;
      paint();
      send({ type: 'load-db-groups' });
      return;
    }
    let action: PanelActionInput;
    try {
      action = JSON.parse(raw) as PanelActionInput;
    } catch {
      return;
    }
    const text = confirmText(action);
    if (text) {
      ui.confirming = { action: raw, text };
      paint();
      return;
    }
    send(action);
  });

  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset['select'] !== undefined) {
      if (el.checked) ui.selected.add(el.dataset['select']);
      else ui.selected.delete(el.dataset['select']);
      paint();
    } else if (el.dataset['dbgroup'] !== undefined) {
      if (el.checked) ui.dbGroups.add(el.dataset['dbgroup']);
      else ui.dbGroups.delete(el.dataset['dbgroup']);
      paint();
    } else if (el.dataset['ui'] === 'includeUploads') {
      ui.includeUploads = el.checked;
      paint();
    }
  });

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset['ui'] === 'filter') {
      ui.filter = el.value;
      paint();
    }
  });

  paint();
  void bridge.getState().then((s) => {
    // Default the database picker to the groups that are safe to push.
    if (s.view === 'tracking' && s.dbGroups) for (const g of s.dbGroups) if (g.pushByDefault) ui.dbGroups.add(g.id);
    accept(s);
  }, unavailable);
}
