import type { Logger } from '../log.js';
import type { RemoteFs, RemoteShell } from '../ssh/types.js';
import type { Ddev } from '../ddev/Ddev.js';

export interface ProgressUpdate {
  /** Short machine-friendly phase, e.g. `files`, `database`, `docker`. */
  phase: string;
  message: string;
  current?: number;
  total?: number;
}

/** Everything an operation needs. The plugin worker builds one per job. */
export interface OperationContext {
  shell: RemoteShell;
  sftp: RemoteFs;
  /** True when the SSH session is root (WHM): uploaded files are chowned back to the account. */
  asRoot: boolean;
  ddev: Ddev;
  logger: Logger;
  signal?: AbortSignal;
  progress: (update: ProgressUpdate) => void;
  concurrency: number;
}

export interface TransferFailure {
  path: string;
  error: string;
}
