import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import * as path from 'node:path';
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

/**
 * The absolute path of a program given by bare name, searching only the
 * absolute folders on PATH (with .exe/.com on Windows). Never the working
 * folder: on Windows, a bare name passed to spawn() is looked up in the
 * child's cwd first, and LocalDock runs ddev in project folders, whose files
 * come from the server and can be written by the site's own code in DDEV.
 * Returns null when it isn't installed; a path is returned unchanged.
 */
export function resolveProgram(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (command.includes('/') || command.includes('\\')) return command;
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const exts = platform === 'win32' ? (/\.(exe|com)$/i.test(command) ? [''] : ['.exe', '.com']) : [''];
  for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
    const clean = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!clean || !p.isAbsolute(clean)) continue;
    for (const ext of exts) {
      const candidate = p.join(clean, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Runs programs directly (no shell), so arguments are never interpreted. */
export const processRunner: CommandRunner = {
  run(command, args, options = {}) {
    return new Promise((resolve) => {
      const program = resolveProgram(command, options.env ?? process.env);
      if (!program) {
        resolve({ code: 127, stdout: '', stderr: `${command}: not found` });
        return;
      }
      const proc = spawn(program, [...args], { cwd: options.cwd, env: options.env, windowsHide: true, signal: options.signal });
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
