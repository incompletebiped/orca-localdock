import type { PanelState } from '../shared/protocol.js';

/**
 * How panel state reaches the panel. GAP panel-bridge: Orca 1.4.222 has no
 * worker → panel channel, so the public build only keeps the latest snapshot.
 * The panel is expected to fetch it through the `localdock.state` command once
 * Orca lets panels invoke their own worker's commands (see PR #25256), or
 * Orca may add a push channel, in which case `publish` forwards it.
 */
export interface PanelTransport {
  publish(state: PanelState): void;
  latest(): PanelState | null;
}

export class SnapshotTransport implements PanelTransport {
  private snapshot: PanelState | null = null;
  publish(state: PanelState): void {
    this.snapshot = state;
  }
  latest(): PanelState | null {
    return this.snapshot;
  }
}
