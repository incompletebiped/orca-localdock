import type { PanelState } from '../shared/protocol.js';
import type { StatusItem } from './orca/host.js';

/** What the status bar shows for a panel state: the tracked site and its pending changes, or a running job. */
export function statusItem(state: PanelState): StatusItem | null {
  if (state.job) {
    const progress = state.job.total ? ` ${state.job.current ?? 0}/${state.job.total}` : '';
    return { text: `${state.job.title}…${progress}`, tooltip: `LocalDock: ${state.job.message}`, tone: 'accent' };
  }
  if (state.view !== 'tracking') return null;
  const { site, ddev, changes } = state;
  const running = ddev.status === 'running';
  const rows = changes?.rows ?? [];
  const count = (d: string) => rows.filter((r) => r.direction === d).length;
  const push = count('push');
  const pull = count('pull');
  const conflicts = count('conflict');
  const parts = [site.domain];
  if (push) parts.push(`↑${push}`);
  if (pull) parts.push(`↓${pull}`);
  if (conflicts) parts.push(`⚠${conflicts}`);
  const tooltip = [
    `LocalDock: ${site.domain} is ${running ? `running at ${ddev.url ?? 'DDEV'}` : 'not running locally'}.`,
    changes
      ? `${push} to push, ${pull} to pull, ${conflicts} changed on both sides.`
      : 'Server not checked yet.',
    'Click to check the server for changes.',
  ].join(' ');
  return { text: parts.join(' '), tooltip, tone: conflicts ? 'warning' : running ? 'success' : 'neutral' };
}
