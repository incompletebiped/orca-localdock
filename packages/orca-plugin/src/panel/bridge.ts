import {
  EVENT_STALE,
  EVENT_STATE,
  REQUEST_DISPATCH,
  REQUEST_OPEN,
  REQUEST_STATE,
  type LinkTarget,
  type OpenLinkResult,
  type PanelActionInput,
  type PanelState,
} from '../shared/protocol.js';

/** How the panel reaches the worker. */
export interface PanelBridge {
  getState(): Promise<PanelState>;
  dispatch(action: PanelActionInput): Promise<PanelState>;
  /** Called with each state the worker pushes. */
  onState(listener: (state: PanelState) => void): void;
  /** Ask the worker to open a link button in Orca's browser. */
  openLink(target: LinkTarget): Promise<OpenLinkResult>;
  /** Open a URL in the default browser. Must run soon after a click in the panel. */
  openUrl(url: string): Promise<void>;
}

/** Thrown when this Orca can't connect the panel to its worker. */
export class BridgeUnavailableError extends Error {
  constructor(detail: string) {
    super(`LocalDock's panel can't reach its worker (${detail}). Update Orca, or restart the plugin.`);
    this.name = 'BridgeUnavailableError';
  }
}

interface OrcaFrameError extends Error {
  code?: string;
}

/** The parts of Orca's frame API (`window.orca`) the panel uses. */
interface OrcaFrame {
  plugin?: {
    request(name: string, input?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
    on(event: string, fn: (payload: unknown) => void): { dispose(): void };
  };
  shell?: { openExternal(url: string): Promise<{ opened: boolean }> };
}

/** Codes meaning the channel itself is missing or broken, rather than one request failing. */
const UNAVAILABLE = new Set(['unknown_method', 'not_permitted', 'unavailable', 'consent_required']);

/** Bridge over Orca's frame API: `orca.plugin.request` to the worker, `orca.plugin.on` for its pushes. */
export class OrcaPanelBridge implements PanelBridge {
  private readonly orca: OrcaFrame | undefined;

  constructor(win: Window = window) {
    this.orca = (win as unknown as { orca?: OrcaFrame }).orca;
  }

  private async request<T = PanelState>(name: string, input?: unknown): Promise<T> {
    const plugin = this.orca?.plugin;
    if (!plugin) throw new BridgeUnavailableError('no orca.plugin');
    try {
      return (await plugin.request(name, input, { timeoutMs: 60_000 })) as T;
    } catch (err) {
      const code = (err as OrcaFrameError).code;
      if (code && UNAVAILABLE.has(code)) throw new BridgeUnavailableError(code);
      throw err;
    }
  }

  getState(): Promise<PanelState> {
    return this.request(REQUEST_STATE);
  }

  dispatch(action: PanelActionInput): Promise<PanelState> {
    return this.request(REQUEST_DISPATCH, action);
  }

  openLink(target: LinkTarget): Promise<OpenLinkResult> {
    return this.request<OpenLinkResult>(REQUEST_OPEN, { target });
  }

  onState(listener: (state: PanelState) => void): void {
    const plugin = this.orca?.plugin;
    if (!plugin) return;
    plugin.on(EVENT_STATE, (s) => listener(s as PanelState));
    // Too large to post: fetch it.
    plugin.on(EVENT_STALE, () => void this.getState().then(listener, () => {}));
  }

  async openUrl(url: string): Promise<void> {
    if (!this.orca?.shell) throw new Error('Opening links needs the Orca desktop app.');
    await this.orca.shell.openExternal(url);
  }
}
