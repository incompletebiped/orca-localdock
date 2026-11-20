/** Validation for actions sent by the panel. Worker-side only (keeps zod out of the panel bundle). */
import { z } from 'zod';

const relPath = z.string().min(1).max(4096);
/**
 * Files for a push or pull: single paths, and/or whole change-list groups
 * (`groups.ts`, `*` for all) that the worker expands from its own change list.
 * Groups keep a click on "Pull all" small: Orca caps a panel request at 64 KiB.
 */
const fileSelection = {
  paths: z.array(relPath).max(2000).default([]),
  groups: z.array(z.string().min(1).max(300)).max(500).default([]),
  allowConflicts: z.boolean().default(false),
};
const tableGroup = z.enum(['content', 'config', 'users', 'comments', 'commerce', 'plugins', 'other']);

export const panelActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('set-up') }),
  z.object({ type: z.literal('connect-host'), hostId: z.string().min(1).max(256) }),
  z.object({ type: z.literal('scan-sites'), hostId: z.string().min(1).max(256) }),
  z.object({ type: z.literal('back-to-hosts') }),
  z.object({
    type: z.literal('pull-site'),
    hostId: z.string().min(1).max(256),
    account: z.string().min(1).max(64),
    domain: z.string().min(1).max(253),
    includeUploads: z.boolean().default(false),
  }),
  z.object({ type: z.literal('resume-pull') }),
  z.object({ type: z.literal('discard-pull') }),
  z.object({ type: z.literal('scan-changes') }),
  z.object({ type: z.literal('push-files'), ...fileSelection }),
  z.object({ type: z.literal('pull-files'), ...fileSelection }),
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('start-docker') }),
  z.object({ type: z.literal('quit-docker') }),
  z.object({ type: z.literal('keep-docker') }),
  z.object({ type: z.literal('free-space') }),
  z.object({ type: z.literal('load-db-groups') }),
  z.object({ type: z.literal('push-db'), groups: z.array(tableGroup).min(1) }),
  z.object({ type: z.literal('pull-db') }),
  z.object({ type: z.literal('rollback-db'), backupPath: z.string().min(1).max(1024) }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('dismiss-notice') }),
]);

export type PanelAction = z.infer<typeof panelActionSchema>;

/** Input of the panel's `open` request: which link button was clicked. */
export const openLinkSchema = z.object({ target: z.enum(['site', 'admin', 'mailpit', 'live']) });
export type PanelActionInput = z.input<typeof panelActionSchema>;
