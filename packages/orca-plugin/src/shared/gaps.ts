import type { GapId, GapInfo } from './protocol.js';

/**
 * Everything LocalDock needs from Orca that Orca's plugin host API doesn't
 * offer yet. Each gap is one adapter method that throws OrcaApiPendingError
 * today; docs/ORCA-GAPS.md has the details. When Orca ships the capability,
 * only that method changes.
 */
export const GAPS: Record<GapId, GapInfo> = {
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
