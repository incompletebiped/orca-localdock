export type LocalDockErrorCode =
  | 'AUTH_FAILED'
  | 'SSH_TIMEOUT'
  | 'HOST_KEY_MISMATCH'
  | 'HOST_KEY_UNKNOWN'
  | 'SFTP_PERMISSION'
  | 'DISK_FULL'
  | 'DB_EXPORT_FAILED'
  | 'DB_IMPORT_FAILED'
  | 'CONFLICT_DETECTED'
  | 'UNSAFE_INPUT'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'DOCKER_NOT_FOUND'
  | 'DOCKER_START_FAILED'
  | 'DOCKER_STOP_FAILED'
  | 'DRIVE_INELIGIBLE'
  | 'REMOTE_COMMAND_FAILED'
  | 'UNKNOWN';

export class LocalDockError extends Error {
  constructor(
    message: string,
    public readonly code: LocalDockErrorCode,
    /** True when retrying, or fixing something on the user's side, can succeed. */
    public readonly recoverable = true,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LocalDockError';
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof LocalDockError && err.code === 'CANCELLED';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LocalDockError('Operation cancelled', 'CANCELLED');
  }
}

/** Classify common SSH/network/filesystem errors into LocalDockErrors. */
export function normalizeError(err: unknown): LocalDockError {
  if (err instanceof LocalDockError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;

  if (message.includes('All configured authentication methods failed')) {
    return new LocalDockError('SSH authentication failed', 'AUTH_FAILED', true, { cause: err });
  }
  if (code === 'ENOSPC' || message.includes('ENOSPC')) {
    return new LocalDockError('Local disk is full', 'DISK_FULL', false, { cause: err });
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    message.includes('Timed out while waiting for handshake')
  ) {
    return new LocalDockError(message, 'SSH_TIMEOUT', true, { cause: err });
  }
  if (code === 'EACCES' || message.includes('Permission denied')) {
    return new LocalDockError(message, 'SFTP_PERMISSION', true, { cause: err });
  }
  return new LocalDockError(message, 'UNKNOWN', true, { cause: err });
}
