/**
 * LocalDock plugin worker. Orca forks this as a plain Node process and calls
 * the default export with its plugin API.
 */
import { Ddev } from '@localdock/core';
import { COMMAND_DISPATCH, COMMAND_STATE, type PanelActionInput } from '../shared/protocol.js';
import { LocalDockController } from './controller.js';
import type { OrcaWorkerApi } from './orca/host.js';
import { PluginOrcaHost } from './orca/pluginHost.js';
import { SnapshotTransport } from './transport.js';

let controller: LocalDockController | undefined;

export default function activate(orca: OrcaWorkerApi): void {
  const host = new PluginOrcaHost(orca);
  const transport = new SnapshotTransport();
  const ctl = new LocalDockController({ host, ddev: new Ddev(), publish: (s) => transport.publish(s) });

  // The panel's two entry points. Today nothing can call them from the panel
  // (gap panel-bridge); they're ready for when Orca allows it.
  orca.commands.register(COMMAND_STATE, async () => transport.latest() ?? (await ctl.dispatch({ type: 'refresh' })));
  orca.commands.register(COMMAND_DISPATCH, (args) => ctl.dispatch(args));

  // Command-palette shortcuts for the same actions.
  const shortcut = (id: string, action: PanelActionInput) => orca.commands.register(id, () => ctl.dispatch(action));
  shortcut('localdock.refresh', { type: 'refresh' });
  shortcut('localdock.scan-changes', { type: 'scan-changes' });
  shortcut('localdock.start', { type: 'start' });
  shortcut('localdock.stop', { type: 'stop' });

  orca.events.on('worktree.created', () => ctl.dispatch({ type: 'refresh' }));

  void ctl.dispatch({ type: 'refresh' });
  orca.log('LocalDock worker started (work in progress: see docs/ORCA-GAPS.md)');

  controller = ctl;
}

/** Called by Orca before it shuts the worker down. */
export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
