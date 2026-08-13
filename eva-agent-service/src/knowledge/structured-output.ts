export interface StructuredAttempt<T> {
  complete(input: { attempt: number; repair: boolean; signal?: AbortSignal }): Promise<string>;
  parse(raw: string): T;
}

/** Shared fail-closed schema retry used at model call sites. Raw model text never escapes. */
export async function structuredRetry<T>(
  operation: StructuredAttempt<T>,
  degraded: T,
  options: { attempts?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.min(3, options.attempts ?? 2));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return operation.parse(await operation.complete({ attempt, repair: attempt > 0, signal: options.signal }));
    } catch {
      // The next request explicitly asks the canonical router to repair the schema.
    }
  }
  return structuredClone(degraded);
}

export class StructuredOutput<T> {
  constructor(
    private readonly complete: (repair: boolean) => Promise<string>,
    private readonly validate: (value: unknown) => value is T,
    private readonly degraded: T,
  ) {}

  async run(): Promise<T> {
    return await structuredRetry({
      complete: async ({ repair }) => await this.complete(repair),
      parse: (raw) => {
        const parsed: unknown = JSON.parse(raw);
        if (!this.validate(parsed)) throw new Error("structured_output_schema_invalid");
        return parsed;
      },
    }, this.degraded);
  }
}
