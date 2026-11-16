/** Simple FIFO semaphore used to cap concurrent upstream generations. */
export class Semaphore {
  private active = 0;
  private queue: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];

  constructor(private limit: number) {
    this.limit = Math.max(1, limit);
  }

  stats() {
    return { limit: this.limit, active: this.active, waiting: this.queue.length };
  }

  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(entry.timer);
          this.active++;
          resolve(() => this.release());
        },
        reject,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error("server busy: concurrency limit reached"));
        }, timeoutMs),
      };
      this.queue.push(entry);
    });
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}
