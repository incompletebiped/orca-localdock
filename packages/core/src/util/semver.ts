/**
 * Compare two dotted-numeric version strings (e.g. "0.1.2"). Returns a
 * negative number if `a` < `b`, positive if `a` > `b`, 0 if equal. Missing or
 * non-numeric segments count as 0, so "0.1" and "0.1.0" are equal.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i++) {
    const numA = parseInt(partsA[i] ?? '0', 10) || 0;
    const numB = parseInt(partsB[i] ?? '0', 10) || 0;
    if (numA !== numB) {
      return numA - numB;
    }
  }
  return 0;
}
