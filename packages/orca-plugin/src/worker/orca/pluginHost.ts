import { OrcaApiPendingError } from '../../shared/gaps.js';
import type { OrcaHost, OrcaWorkerApi, ProjectInfo, RemoteSession, SshHostInfo } from './host.js';

/**
 * OrcaHost backed by Orca's plugin Host API v0 (Orca 1.4.222). Implements
 * what the API offers and throws OrcaApiPendingError for the rest. When Orca
 * adds a capability, fill in the matching method here (and drop the gap
 * from docs/ORCA-GAPS.md).
 */
export class PluginOrcaHost implements OrcaHost {
  constructor(private readonly orca: OrcaWorkerApi) {}

  async activeProject(): Promise<ProjectInfo | null> {
    // `workspace.readContext` exists but returns only { branch, displayName,
    // terminals }. Without the folder path LocalDock can't pull into or scan
    // the project, so a null context means "no project" and anything else is a gap.
    const ctx = await this.orca.host.call('workspace.readContext');
    if (ctx === null) return null;
    throw new OrcaApiPendingError('project-path');
  }

  async listSshHosts(): Promise<SshHostInfo[]> {
    throw new OrcaApiPendingError('ssh-hosts');
  }

  async connectSshHost(_hostId: string): Promise<void> {
    throw new OrcaApiPendingError('ssh-hosts');
  }

  async openSession(_hostId: string): Promise<RemoteSession> {
    throw new OrcaApiPendingError('ssh-session');
  }

  async openUrl(_url: string): Promise<void> {
    throw new OrcaApiPendingError('open-url');
  }

  async notify(title: string, body?: string): Promise<void> {
    await this.orca.host.call('notifications.show', { title: title.slice(0, 120), ...(body ? { body: body.slice(0, 1000) } : {}) });
  }

  async storageGet<T>(key: string): Promise<T | undefined> {
    const r = (await this.orca.host.call('storage.get', { key })) as { value?: T } | undefined;
    return r?.value ?? undefined;
  }

  async storageSet(key: string, value: unknown): Promise<void> {
    await this.orca.host.call('storage.set', { key, value });
  }

  log(message: string): void {
    this.orca.log(message);
  }
}
