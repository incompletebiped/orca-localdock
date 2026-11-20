import { partialGroups } from '../shared/groups.js';
import { linkUrl, type OpenLink, type PanelActionInput, type PanelState } from '../shared/protocol.js';
import { BridgeUnavailableError, type PanelBridge } from './bridge.js';
import { newUiState, render, type UiState } from './render.js';

/** The worker pushes every change; these slow polls only catch a push that got lost. */
const POLL_BUSY_MS = 3000;
const POLL_IDLE_MS = 15000;

/** Wires the rendered panel to a bridge: clicks become actions, and the worker's pushes repaint it. */
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
    const text = String((err as Error)?.message ?? err);
    if (err instanceof BridgeUnavailableError) state = { view: 'error', message: text, revision: state.revision, job: null, notice: null };
    else state = { ...state, notice: { kind: 'error', text } };
    paint();
    schedule();
  };

  const accept = (next: PanelState) => {
    // Pushes and request answers can cross; never step back to an older state.
    if (next.revision < state.revision && state.view !== 'error') return schedule();
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
  };

  const openLink = (link: OpenLink) => {
    const url = linkUrl(state, link.target);
    const failed = (text: string) => {
      state = { ...state, notice: { kind: 'error', text } };
      paint();
    };
    if (!url) return failed('Start the local site first.');
    // Orca's browser first; the default browser if Orca's CLI couldn't be reached.
    bridge
      .openLink(link.target)
      .then((r) => (r.opened ? undefined : bridge.openUrl(r.url ?? url)))
      .catch(() => bridge.openUrl(url))
      .catch((err: Error) => failed(err.message));
  };

  /** Text for actions that need an inline confirmation first. */
  const confirmText = (action: PanelActionInput): string | null => {
    if (action.type === 'push-db') return 'Overwrite the selected tables on the LIVE site? A backup is taken first.';
    if (action.type === 'rollback-db') return 'Restore the live database to the backup taken before the last push?';
    const texts: string[] = [];
    if ((action.type === 'push-files' || action.type === 'pull-files') && action.allowConflicts) {
      texts.push('These files changed on both sides. Overwrite the other side’s version?');
    }
    if (action.type === 'pull-files' && state.view === 'tracking') {
      const pullable = (state.changes?.rows ?? []).filter((r) => r.direction === 'pull' || r.direction === 'conflict').map((r) => r.path);
      const partial = partialGroups(action.paths, pullable);
      if (partial.length > 0) {
        const list = partial.slice(0, 3).map((g) => `${g.selected} of ${g.total} changed files in ${g.group}`).join(', ');
        texts.push(`This pulls only part of an update (${list}${partial.length > 3 ? ', …' : ''}), which can leave the local site running mismatched code. Pull just these anyway?`);
      }
    }
    return texts.length > 0 ? texts.join(' ') : null;
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
    let action: PanelActionInput | OpenLink;
    try {
      action = JSON.parse(raw) as PanelActionInput | OpenLink;
    } catch {
      return;
    }
    if (action.type === 'open') return openLink(action);
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
  bridge.onState(accept);
  void bridge.getState().then((s) => {
    // Default the database picker to the groups that are safe to push.
    if (s.view === 'tracking' && s.dbGroups) for (const g of s.dbGroups) if (g.pushByDefault) ui.dbGroups.add(g.id);
    accept(s);
  }, unavailable);
}
