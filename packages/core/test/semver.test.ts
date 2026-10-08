import { describe, it, expect } from 'vitest';
import { compareVersions } from '../src/util/semver.js';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('0.1.2', '0.1.2')).toBe(0);
  });

  it('treats missing trailing segments as 0', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
  });

  it('returns negative when a < b', () => {
    expect(compareVersions('0.1.1', '0.1.2')).toBeLessThan(0);
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.9.9', '1.0.0')).toBeLessThan(0);
  });

  it('returns positive when a > b', () => {
    expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });

  it('treats non-numeric segments as 0', () => {
    expect(compareVersions('0.1.x', '0.1.0')).toBe(0);
  });
});
