/** Validation for actions sent by the panel. Worker-side only (keeps zod out of the panel bundle). */
import { z } from 'zod';

const relPath = z.string().min(1).max(4096);
const tableGroup = z.enum(['content', 'config', 'users', 'comments', 'commerce', 'plugins', 'other']);

export const panelActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('refresh') }),
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
  z.object({ type: z.literal('scan-changes') }),
  z.object({ type: z.literal('push-files'), paths: z.array(relPath).min(1).max(20000), allowConflicts: z.boolean().default(false) }),
  z.object({ type: z.literal('pull-files'), paths: z.array(relPath).min(1).max(20000), allowConflicts: z.boolean().default(false) }),
  z.object({ type: z.literal('start') }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('open'), target: z.enum(['site', 'admin', 'mailpit', 'live']) }),
  z.object({ type: z.literal('load-db-groups') }),
  z.object({ type: z.literal('push-db'), groups: z.array(tableGroup).min(1) }),
  z.object({ type: z.literal('pull-db') }),
  z.object({ type: z.literal('rollback-db'), backupPath: z.string().min(1).max(1024) }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('dismiss-notice') }),
]);

export type PanelAction = z.infer<typeof panelActionSchema>;
export type PanelActionInput = z.input<typeof panelActionSchema>;
