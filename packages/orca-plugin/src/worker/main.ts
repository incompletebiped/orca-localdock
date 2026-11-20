/**
 * LocalDock plugin worker. Orca runs this as a plain Node process and calls
 * the default export with its plugin API.
 */
import { Ddev } from '@localdock/core';
import { openLinkSchema } from '../shared/actionSchema.js';
import { REQUEST_DISPATCH, REQUEST_OPEN, REQUEST_STATE, type OpenLinkResult, type PanelActionInput, type PanelState } from '../shared/protocol.js';
import { LocalDockController } from './controller.js';
import type { OrcaHost, OrcaWorkerApi, StatusItem } from './orca/host.js';
import { PluginOrcaHost } from './orca/pluginHost.js';
import { statusItem } from './status.js';
import { PostTransport } from './transport.js';

/** How long a panel request waits for its action before answering with the state so far; pushes carry the rest. */
const DISPATCH_ANSWER_MS = 400;

let controller: LocalDockController | undefined;
let transport: PostTransport | undefined;

export default function activate(orca: OrcaWorkerApi): void {
  startWorker(orca, new PluginOrcaHost(orca));
}

/** Wire the worker to Orca with a given OrcaHost (a fork can pass one that fills the gaps). */
export function startWorker(orca: OrcaWorkerApi, host: OrcaHost): void {
  const posts = new PostTransport((event, payload) => orca.panels.post(event, payload));
  const status = statusUpdater(host);
  const ctl = new LocalDockController({
    host,
    ddev: new Ddev(),
    publish: (s) => {
      posts.publish(s);
      status(s);
    },
  });

  // The panel's two requests. A dispatch can run for minutes (a pull), longer
  // than a panel request may wait, so it answers early and the rest arrives as posts.
  orca.panels.handle(REQUEST_STATE, async () => toJson(posts.latest() ?? (await ctl.dispatch({ type: 'refresh' }))));
  orca.panels.handle(REQUEST_DISPATCH, async (input) => {
    const done = ctl.dispatch(input);
    return toJson(await Promise.race([done, new Promise<PanelState>((r) => setTimeout(() => r(ctl.state()), DISPATCH_ANSWER_MS))]));
  });
  orca.panels.handle(REQUEST_OPEN, async (input): Promise<OpenLinkResult> => {
    const parsed = openLinkSchema.safeParse(input);
    return parsed.success ? ctl.openLink(parsed.data.target) : { opened: false, url: null };
  });

  // Command-palette shortcuts for the same actions.
  const shortcut = (id: string, action: PanelActionInput) => orca.commands.register(id, () => ctl.dispatch(action));
  shortcut('localdock.refresh', { type: 'refresh' });
  shortcut('localdock.scan-changes', { type: 'scan-changes' });
  shortcut('localdock.start', { type: 'start' });
  shortcut('localdock.stop', { type: 'stop' });

  // Another project got focus (or the focused one's terminals changed): show that project.
  orca.events.on('workspace.changed', () => ctl.dispatch({ type: 'refresh' }));

  void ctl.dispatch({ type: 'refresh' });
  orca.log('LocalDock worker started (work in progress: see docs/ORCA-GAPS.md)');

  controller = ctl;
  transport = posts;
}

/**
 * Orca refuses a request answer that isn't plain JSON, and a field set to
 * `undefined` (an optional URL, a missing date) counts. A round trip drops those.
 */
export function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Keep the status bar item in step with the state, sending only real changes, one at a time. */
function statusUpdater(host: OrcaHost): (state: PanelState) => void {
  let shown: string | undefined;
  let pending: StatusItem | null | undefined;
  let sending = false;
  let warned = false;
  const send = async () => {
    sending = true;
    while (pending !== undefined) {
      const item = pending;
      pending = undefined;
      const key = JSON.stringify(item);
      if (key === shown) continue;
      try {
        await host.setStatus(item);
        shown = key;
      } catch (err) {
        // The status bar is desktop-only; a headless Orca has none.
        if (!warned) host.log(`Status bar: ${(err as Error).message}`);
        warned = true;
      }
    }
    sending = false;
  };
  return (state) => {
    pending = statusItem(state);
    if (!sending) void send();
  };
}

/** Called by Orca before it shuts the worker down. */
export function deactivate(): void {
  transport?.dispose();
  controller?.dispose();
  controller = undefined;
  transport = undefined;
}
