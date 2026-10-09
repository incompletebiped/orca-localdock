/** Human-readable size, e.g. `812 KB`, `12.4 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Progress of a streamed transfer: bytes so far, and the expected total when known (an estimate for dumps). */
export type ByteProgress = (bytes: number, total: number | undefined) => void;

/** Calls `onProgress` at most every `everyMs` while counting; `flush()` reports the final count. */
export function byteCounter(onProgress: ByteProgress | undefined, total: number | undefined, everyMs = 250) {
  let bytes = 0;
  let at = 0;
  return {
    add(n: number): void {
      bytes += n;
      const now = Date.now();
      if (onProgress && now - at >= everyMs) {
        at = now;
        onProgress(bytes, total);
      }
    },
    flush(finalTotal = total): void {
      onProgress?.(bytes, finalTotal);
    },
    get bytes(): number {
      return bytes;
    },
  };
}
