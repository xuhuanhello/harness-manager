import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Watches the stable library parent; callbacks run through the controller's mutation queue. */
export class LibraryObserver {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private fallback?: ReturnType<typeof setInterval>;
  private affected = new Set<string>();
  private closed = false;
  constructor(
    private root: string,
    private refresh: (ids: string[]) => Promise<void>,
    private report: (error: unknown) => void = console.error,
  ) {}
  /** True while file events are being delivered; false after falling back to polling. */
  get watching(): boolean {
    return Boolean(this.watcher) && !this.closed;
  }
  async start() {
    if (this.closed) return;
    const directory = path.join(this.root, 'skills');
    await mkdir(directory, { recursive: true });
    try {
      this.watcher = watch(directory, { recursive: true, persistent: false }, (_event, filename) => {
        const id = filename?.toString().split(/[\\/]/)[0];
        if (!id) return;
        this.affected.add(id);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const ids = [...this.affected];
          this.affected.clear();
          this.timer = undefined;
          if (!this.closed) void this.refresh(ids).catch(this.report);
        }, 400);
        this.timer.unref();
      });
      this.watcher.on('error', (error) => this.fallBackToPolling(error));
    } catch (error) {
      this.fallBackToPolling(error);
    }
  }
  private fallBackToPolling(error: unknown) {
    this.report(error);
    this.watcher?.close();
    this.watcher = undefined;
    if (!this.closed && !this.fallback) {
      this.fallback = setInterval(() => {
        if (!this.closed) void this.refresh([]).catch(this.report);
      }, 60000);
      this.fallback.unref();
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.fallback) clearInterval(this.fallback);
    this.watcher?.close();
    this.affected.clear();
  }
}
