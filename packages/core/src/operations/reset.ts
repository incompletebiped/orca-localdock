import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Ddev } from '../ddev/Ddev.js';
import { LocalDockError } from '../errors.js';
import { LOCALDOCK_DIR } from '../sync/state.js';
import { PROJECT_SCAFFOLD_ENTRIES } from './site.js';

export interface ProjectResetPlan {
  projectDir: string;
  /** Top-level entries to delete. */
  remove: string[];
  /** Top-level entries kept: .git and whatever else a new project starts with. */
  keep: string[];
  /** A DDEV project is configured here; its containers and database go too. */
  ddev: boolean;
}

/**
 * Work out what clearing a pulled (or partly pulled) site from a project would
 * delete. Only folders with a `.localdock` folder qualify, so an ordinary
 * project can't be emptied by mistake.
 */
export async function planProjectReset(projectDir: string): Promise<ProjectResetPlan> {
  const dir = path.resolve(projectDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new LocalDockError(`No such folder: ${dir}`, 'NOT_FOUND', false);
  }
  if (!entries.includes(LOCALDOCK_DIR)) {
    throw new LocalDockError(`${dir} has no ${LOCALDOCK_DIR} folder, so LocalDock didn't pull a site into it.`, 'NOT_FOUND', false);
  }
  const sorted = [...entries].sort();
  return {
    projectDir: dir,
    remove: sorted.filter((e) => !PROJECT_SCAFFOLD_ENTRIES.has(e)),
    keep: sorted.filter((e) => PROJECT_SCAFFOLD_ENTRIES.has(e)),
    ddev: entries.includes('.ddev'),
  };
}

/** Carry out a plan: delete the DDEV project (when `ddev` is given), then the files. */
export async function resetProject(plan: ProjectResetPlan, ddev: Ddev | null, onProgress: (message: string) => void = () => {}): Promise<void> {
  if (plan.ddev && ddev) {
    onProgress('Deleting the DDEV project (containers and database)…');
    await ddev.delete(plan.projectDir);
  }
  for (const entry of plan.remove) {
    onProgress(`Deleting ${entry}`);
    // Symlinks are removed, not followed.
    await fs.rm(path.join(plan.projectDir, entry), { recursive: true, force: true, maxRetries: 3 });
  }
}
