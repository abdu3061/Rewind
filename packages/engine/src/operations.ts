import { appErrorSchema, failure, type Result } from "@rewind/contracts";

/** Deadlines report uncertainty; the underlying work remains tracked until settlement. */
export class Operations {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly timeoutMs: number) {}
  get unsettled(): boolean {
    return this.pending.size !== 0;
  }

  async run<T>(
    label: string,
    call: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const work = Promise.resolve()
      .then(call)
      .then((result): Result<T> => {
        if (result?.ok === true) return result;
        const parsed = appErrorSchema.safeParse(result?.error);
        return failure(
          parsed.success ? parsed.data.code : "INTERNAL",
          `${label} failed.`,
        );
      })
      .catch(() => failure("UNAVAILABLE", `${label} failed.`));
    this.pending.add(work);
    void work.then(() => this.pending.delete(work));
    return this.deadline(work, label);
  }

  async drain(): Promise<Result<void>> {
    return this.deadline(
      Promise.all([...this.pending]).then(() => ({
        ok: true as const,
        value: undefined,
      })),
      "Pending work",
    );
  }

  private async deadline<T>(
    work: Promise<Result<T>>,
    label: string,
  ): Promise<Result<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<Result<T>>((resolve) => {
          timer = setTimeout(
            () =>
              resolve(
                failure("UNAVAILABLE", `${label} did not finish in time.`),
              ),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
