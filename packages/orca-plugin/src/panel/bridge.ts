import { COMMAND_DISPATCH, COMMAND_STATE, type PanelActionInput, type PanelState } from '../shared/protocol.js';

/** How the panel reaches the worker. */
export interface PanelBridge {
  getState(): Promise<PanelState>;
  dispatch(action: PanelActionInput): Promise<PanelState>;
}

/** Thrown when Orca rejects the request because panels can't call their worker yet (gap panel-bridge). */
export class BridgeUnavailableError extends Error {
  constructor(detail: string) {
    super(`Orca doesn't let plugin panels call their worker yet (${detail})`);
    this.name = 'BridgeUnavailableError';
  }
}

interface ActionResult {
  type: 'orca-panel-action-result';
  requestId: string;
  ok: boolean;
  value?: unknown;
  errorCode?: string;
  error?: string;
}

/**
 * Bridge over Orca's panel postMessage protocol. It invokes the worker's
 * `localdock.state` / `localdock.dispatch` commands through a panel action
 * named `commands.invoke`. That action doesn't exist in Orca 1.4.222 (only
 * workspace.readContext, terminal.sendText and notifications.show do); it
 * matches the shape proposed in stablyai/orca PR #25256. When Orca ships the
 * capability under another name, only this class changes.
 */
export class OrcaPanelBridge implements PanelBridge {
  private seq = 0;
  private readonly pending = new Map<string, (r: ActionResult) => void>();

  constructor(private readonly win: Window = window) {
    win.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as ActionResult | undefined;
      if (event.source !== win.parent || !data || data.type !== 'orca-panel-action-result') return;
      const resolve = this.pending.get(data.requestId);
      if (resolve) {
        this.pending.delete(data.requestId);
        resolve(data);
      }
    });
  }

  private call(action: string, params: unknown, timeoutMs = 60_000): Promise<ActionResult> {
    const requestId = `ld-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BridgeUnavailableError('no reply'));
      }, timeoutMs);
      this.pending.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      // The panel frame has an opaque origin, so '*' is the only usable target; Orca checks the sending window.
      this.win.parent.postMessage({ type: 'orca-panel-action', requestId, action, params }, '*');
    });
  }

  private async invoke(commandId: string, args?: unknown): Promise<PanelState> {
    const r = await this.call('commands.invoke', { commandId, ...(args === undefined ? {} : { args }) });
    if (!r.ok) {
      // Unknown action / capability means this Orca build predates the API.
      throw new BridgeUnavailableError(r.errorCode ?? r.error ?? 'rejected');
    }
    const value = r.value as { value?: unknown } | PanelState;
    return ((value as { value?: unknown }).value ?? value) as PanelState;
  }

  getState(): Promise<PanelState> {
    return this.invoke(COMMAND_STATE);
  }

  dispatch(action: PanelActionInput): Promise<PanelState> {
    return this.invoke(COMMAND_DISPATCH, action);
  }
}
