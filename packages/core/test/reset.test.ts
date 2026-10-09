import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Ddev } from '../src/ddev/Ddev.js';
import type { CommandRunner } from '../src/ddev/runner.js';
import { planProjectReset, resetProject } from '../src/operations/reset.js';

async function project(entries: Record<string, string | null>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ld-reset-'));
  for (const [rel, content] of Object.entries(entries)) {
    const p = path.join(dir, rel);
    if (content === null) await fs.mkdir(p, { recursive: true });
    else {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
    }
  }
  return dir;
}

function recordingDdev() {
  const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
  const runner: CommandRunner = {
    async run(_command, args, options) {
      calls.push({ args, cwd: options?.cwd });
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  return { ddev: new Ddev(runner), calls };
}

describe('project reset', () => {
  it('refuses a folder LocalDock never pulled into', async () => {
    const dir = await project({ '.git/HEAD': 'ref', 'index.php': '' });
    await expect(planProjectReset(dir)).rejects.toThrow(/no \.localdock folder/);
    expect((await fs.readdir(dir)).sort()).toEqual(['.git', 'index.php']);
  });

  it('deletes a partial pull but keeps .git and new-project files', async () => {
    const dir = await project({ '.git/HEAD': 'ref', '.gitignore': 'x', '.localdock': null, 'wp-content/themes/a.php': '' });
    const plan = await planProjectReset(dir);
    expect(plan).toMatchObject({ remove: ['.localdock', 'wp-content'], keep: ['.git', '.gitignore'], ddev: false });
    const { ddev, calls } = recordingDdev();
    await resetProject(plan, ddev);
    expect(calls).toEqual([]);
    expect((await fs.readdir(dir)).sort()).toEqual(['.git', '.gitignore']);
  });

  it('deletes the DDEV project before the files of a whole pull', async () => {
    const dir = await project({ '.localdock/state.json': '{}', '.ddev/config.yaml': '', 'wp-config.php': '' });
    const plan = await planProjectReset(dir);
    expect(plan.ddev).toBe(true);
    const { ddev, calls } = recordingDdev();
    const log: string[] = [];
    await resetProject(plan, ddev, (m) => log.push(m));
    expect(calls).toEqual([{ args: ['delete', '--omit-snapshot', '--yes'], cwd: plan.projectDir }]);
    expect(log[0]).toMatch(/DDEV/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('skips DDEV when it is not available', async () => {
    const dir = await project({ '.localdock': null, '.ddev/config.yaml': '' });
    await resetProject(await planProjectReset(dir), null);
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
