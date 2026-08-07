// Autosave: the thing standing between a merchant's afternoon and a closed
// tab.
//
// Framework-free on purpose. The awkward parts of autosave are not React —
// they are coalescing a burst of edits into one write, never running two
// writes at once, carrying the revision forward so the next write is not a
// conflict, and knowing what to do when it IS one. All of that is here,
// with the timer injected, so it can be tested by hand rather than by
// waiting.

export type SaveState =
  /** Nothing to save. */
  | 'clean'
  /** Edited, waiting for the burst to settle. */
  | 'pending'
  | 'saving'
  /** Written, and nothing has changed since. */
  | 'saved'
  /** Someone else moved the project on. Only a reload fixes this. */
  | 'conflict'
  /** The write failed — network, or the service. It will be retried. */
  | 'error';

export interface AutosaveOptions<T> {
  /** Write it. Resolves with the revision the service now holds. */
  save(payload: T, baseRevision: number): Promise<{ revision: number }>;
  /** The revision last read from the service. */
  revision: number;
  onState(state: SaveState, detail?: { message?: string; revision?: number }): void;
  /** How long a burst of edits is allowed to settle. */
  delayMs?: number;
  /** Injected so tests drive time by hand. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export class Autosave<T> {
  private opts: Required<Omit<AutosaveOptions<T>, 'revision'>> & { revision: number };
  private timer: unknown = null;
  private queued: T | null = null;
  private inFlight = false;
  /** Set once a conflict is seen. Nothing is written after that: the local
   * copy is no longer a valid successor to what the service holds, and
   * writing anyway is how the other tab's work disappears. */
  private stopped = false;

  constructor(options: AutosaveOptions<T>) {
    this.opts = {
      delayMs: 1200,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      ...options,
    } as Required<Omit<AutosaveOptions<T>, 'revision'>> & { revision: number };
  }

  get revision(): number { return this.opts.revision; }
  get isStopped(): boolean { return this.stopped; }

  /** An edit happened. The newest payload wins — an intermediate state of a
   * gizmo drag is not worth a request. */
  push(payload: T): void {
    if (this.stopped) return;
    this.queued = payload;
    this.opts.onState('pending');
    if (this.timer != null) this.opts.cancel(this.timer);
    this.timer = this.opts.schedule(() => { this.timer = null; void this.run(); }, this.opts.delayMs);
  }

  /** Write now — leaving the page, or hitting Publish. */
  async flush(): Promise<void> {
    if (this.timer != null) { this.opts.cancel(this.timer); this.timer = null; }
    await this.run();
  }

  dispose(): void {
    if (this.timer != null) this.opts.cancel(this.timer);
    this.timer = null;
    this.queued = null;
  }

  private async run(): Promise<void> {
    // One write at a time. A second would race the first for the same
    // revision and lose — and the loser would be a 409 on our own edit.
    if (this.inFlight || this.stopped || this.queued === null) return;
    const payload = this.queued;
    this.queued = null;
    this.inFlight = true;
    this.opts.onState('saving');
    try {
      const { revision } = await this.opts.save(payload, this.opts.revision);
      this.opts.revision = revision;
      this.opts.onState(this.queued === null ? 'saved' : 'pending');
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        this.stopped = true;
        this.opts.onState('conflict', {
          message: 'This product was changed somewhere else. Reload to pick up that copy.',
          revision: (err as { detail?: { revision?: number } }).detail?.revision,
        });
      } else {
        // Put the work back and let the next edit — or the next flush —
        // carry it. A failed save must never silently drop the payload.
        if (this.queued === null) this.queued = payload;
        this.opts.onState('error', { message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.inFlight = false;
    }
    if (this.queued !== null && !this.stopped && this.timer == null) {
      this.timer = this.opts.schedule(() => { this.timer = null; void this.run(); }, this.opts.delayMs);
    }
  }
}

/** What the merchant reads in the topbar. Short, and never alarming about
 * something that is merely in progress. */
export function saveLabel(state: SaveState): string {
  switch (state) {
    case 'clean': return '';
    case 'pending': return 'Saving…';
    case 'saving': return 'Saving…';
    case 'saved': return 'Saved';
    case 'conflict': return 'Changed elsewhere';
    case 'error': return 'Not saved — retrying';
  }
}
