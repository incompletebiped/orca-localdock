import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface RunOptions {
  cwd?: string;
  stdin?: Readable;
  /** Pipe stdout here instead of buffering it. */
  stdout?: Writable;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a local program. Abstracted so DDEV calls can be tested without DDEV installed. */
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

/** Runs programs directly (no shell), so arguments are never interpreted. */
export const processRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve) => {
      const proc = spawn(command, [...args], { cwd: options.cwd, windowsHide: true, signal: options.signal });
      let stdout = '';
      let stderr = '';
      if (options.stdout) proc.stdout.pipe(options.stdout, { end: false });
      else proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      if (options.stdin) options.stdin.pipe(proc.stdin);
      else proc.stdin.end();
      proc.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};
