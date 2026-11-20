import { EVENT_STALE, EVENT_STATE, type PanelState } from '../shared/protocol.js';

/** How panel state reaches the panel. */
export interface PanelTransport {
  publish(state: PanelState): void;
  latest(): PanelState | null;
}

/** Orca refuses posts over 256 KiB; leave room for the envelope. */
const MAX_POST_BYTES = 240 * 1024;
/** Orca allows 200 posts per 10 s per plugin; job progress can change faster than that. */
const MIN_POST_INTERVAL_MS = 100;

type Post = (event: string, payload: unknown) => void;

/**
 * Pushes each new state to the open panels with `orca.panels.post`, at most
 * once per MIN_POST_INTERVAL_MS (the latest state always goes out). A state
 * too large to post (a change list of thousands of files) goes out as a small
 * "stale" notice instead, and the panel fetches it with `plugin.request`,
 * whose answers may be up to 1 MiB. The latest snapshot is kept for those requests.
 */
export class PostTransport implements PanelTransport {
  private snapshot: PanelState | null = null;
  private lastPost = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly post: Post,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  publish(state: PanelState): void {
    this.snapshot = state;
    if (this.timer) return;
    const wait = this.lastPost + MIN_POST_INTERVAL_MS - this.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  latest(): PanelState | null {
    return this.snapshot;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flush(): void {
    this.timer = undefined;
    const state = this.snapshot;
    if (!state) return;
    this.lastPost = this.now();
    try {
      const json = JSON.stringify(state);
      if (Buffer.byteLength(json) > MAX_POST_BYTES) this.post(EVENT_STALE, { revision: state.revision });
      // Plain JSON only (no `undefined` fields), as Orca expects of what reaches a panel.
      else this.post(EVENT_STATE, JSON.parse(json));
    } catch (err) {
      // No panel open, or rate limited: the panel catches up with its next request.
      this.onError(err);
    }
  }
}
