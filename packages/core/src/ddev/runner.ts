import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface RunOptions {
  cwd?: string;
  stdin?: Readable;
  /** Pipe stdout here instead of buffering it. */
  stdout?: Writable;
  signal?: AbortSignal;
  /** Environment for the program (defaults to this process's). */
  env?: NodeJS.ProcessEnv;
  /** Called with each non-empty line of output (stdout and stderr) as it arrives, for progress. */
  onLine?: (line: string) => void;
}

/** Split a stream's chunks into lines for `onLine`, dropping terminal color codes. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = '';
  return (chunk) => {
    const lines = (rest + chunk.toString('utf-8')).split(/\r?\n|\r/);
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').trim();
      if (clean) onLine(clean);
    }
  };
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
      const proc = spawn(command, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, signal: options.signal });
      let stdout = '';
      let stderr = '';
      if (options.stdout) proc.stdout.pipe(options.stdout, { end: false });
      else proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      if (options.onLine) {
        const outLines = lineSplitter(options.onLine);
        const errLines = lineSplitter(options.onLine);
        proc.stdout.on('data', outLines);
        proc.stderr.on('data', errLines);
      }
      if (options.stdin) options.stdin.pipe(proc.stdin);
      else proc.stdin.end();
      proc.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};

/** Starts a desktop app and returns once it has launched, without waiting for it to exit. */
export type AppLauncher = (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<void>;

export const detachedLauncher: AppLauncher = (command, args, env) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], { env, detached: true, stdio: 'ignore' });
    proc.once('error', reject);
    proc.once('spawn', () => {
      proc.unref();
      resolve();
    });
  });
