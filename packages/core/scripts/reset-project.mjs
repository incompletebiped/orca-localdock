// Clear a pulled (or partly pulled) site out of a project, so LocalDock can pull into it again.
//
//   npm run reset-project -- <project folder>          show what would be deleted
//   npm run reset-project -- <project folder> --yes    delete it
//
// Deletes the site's DDEV project (containers and database) and every file except .git and the
// other files a new project starts with. Refuses folders without a .localdock folder.
import { Ddev, planProjectReset, resetProject } from '../dist/index.js';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const dirs = args.filter((a) => !a.startsWith('--'));
if (dirs.length !== 1) {
  console.error('Usage: npm run reset-project -- <project folder> [--yes]');
  process.exit(2);
}

try {
  const plan = await planProjectReset(dirs[0]);
  const ddev = new Ddev();
  const ddevInstalled = plan.ddev && (await ddev.version()) !== null;

  console.log(`Project: ${plan.projectDir}\n`);
  if (plan.ddev) {
    console.log(ddevInstalled ? 'Delete the DDEV project (containers and database).' : 'DDEV is configured here but not installed, so only files will be deleted.');
  }
  const shown = plan.remove.slice(0, 25);
  console.log(`Delete ${plan.remove.length} item(s):\n${shown.map((e) => `  ${e}`).join('\n')}${plan.remove.length > shown.length ? `\n  … and ${plan.remove.length - shown.length} more` : ''}`);
  console.log(`Keep: ${plan.keep.join(', ') || '(nothing)'}\n`);

  if (!yes) {
    console.log('Nothing deleted yet. Cancel any pull running in this project, then run again with --yes.');
    process.exit(0);
  }
  await resetProject(plan, ddevInstalled ? ddev : null, (m) => console.log(m));
  console.log('\nDone. The project is empty again; run "LocalDock: Refresh" in Orca.');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
