import { throwIfAborted } from '../errors.js';

/**
 * Run `worker` over `items` with at most `limit` in flight. Every item is
 * attempted (unless `signal` aborts), and failures are collected rather than
 * stopping the batch.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<{ item: T; ok: true; value: R } | { item: T; ok: false; error: unknown }>> {
  const results: Array<{ item: T; ok: true; value: R } | { item: T; ok: false; error: unknown }> =
    new Array(items.length);
  let next = 0;

  const run = async (): Promise<void> => {
    while (next < items.length) {
      throwIfAborted(signal);
      const index = next++;
      const item = items[index]!;
      try {
        results[index] = { item, ok: true, value: await worker(item, index) };
      } catch (error) {
        results[index] = { item, ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
  throwIfAborted(signal);
  return results;
}
