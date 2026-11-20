import { failure, type Result } from "@rewind/contracts";

/** Electron event callbacks do not await Promises. Prevent exit until shutdown acknowledges. */
export class QuitGuard {
  private complete = false;
  private pending: Promise<void> | null = null;
  constructor(
    private readonly options: {
      shutdown: () => Promise<Result<void>>;
      quit: () => void;
      failed: () => void;
    },
  ) {}

  beforeQuit(event: { preventDefault(): void }): void {
    if (this.complete) return;
    event.preventDefault();
    if (this.pending) return;
    this.pending = Promise.resolve()
      .then(this.options.shutdown)
      .catch(() => failure("UNAVAILABLE", "Shutdown failed."))
      .then((result) => {
        if (!result.ok) {
          this.options.failed();
          return;
        }
        this.complete = true;
        this.options.quit();
      })
      .finally(() => {
        this.pending = null;
      });
  }
}
