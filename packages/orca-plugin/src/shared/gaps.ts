import type { GapId, GapInfo } from './protocol.js';

/**
 * Everything LocalDock needs from Orca that Orca 1.4.222 doesn't offer
 * plugins. Each gap is one adapter method that throws OrcaApiPendingError
 * today; docs/ORCA-GAPS.md has the details and upstream links. When Orca
 * ships the capability, only that method changes.
 */
export const GAPS: Record<GapId, GapInfo> = {
  'panel-bridge': {
    id: 'panel-bridge',
    title: 'Panel ↔ worker messaging',
    need: 'The sidebar panel must be able to call its own plugin worker and receive updated state from it.',
  },
  'project-path': {
    id: 'project-path',
    title: 'Active project folder',
    need: 'The plugin must know the folder of the project open in Orca, to pull a site into it and track its changes.',
  },
  'ssh-hosts': {
    id: 'ssh-hosts',
    title: 'Orca SSH hosts',
    need: 'The plugin must be able to list the SSH hosts configured in Orca, see whether they are connected, and ask Orca to connect.',
  },
  'ssh-session': {
    id: 'ssh-session',
    title: 'Commands and file transfer over Orca SSH',
    need: 'The plugin must be able to run commands and transfer files over an Orca SSH connection.',
  },
  'open-url': {
    id: 'open-url',
    title: "Open a URL in Orca's browser",
    need: 'The plugin should be able to open the local site, WP Admin and Mailpit in an Orca browser tab.',
  },
};

export class OrcaApiPendingError extends Error {
  constructor(readonly gap: GapId) {
    super(`Waiting on Orca: ${GAPS[gap].title}. ${GAPS[gap].need}`);
    this.name = 'OrcaApiPendingError';
  }
}

export function isOrcaApiPending(err: unknown): err is OrcaApiPendingError {
  return err instanceof OrcaApiPendingError;
}
