import { findGaps, nearestObservationIndex, validateRange } from './range';
import { DAY, fromInputValue, fmtRangeCompact } from './format';
import type { Observation } from '../../types';

const U = (iso: string) => Date.parse(iso);
const obs = (times: number[]): Observation[] => times.map((t, i) => ({ id: String(i), time: t, kind: 'observed' }));

describe('validateRange', () => {
  it('accepts a normal range', () => {
    expect(validateRange(U('2026-01-01T00:00:00Z'), U('2026-02-01T00:00:00Z')).ok).toBe(true);
  });
  it('rejects end before start', () => {
    const v = validateRange(U('2026-02-01T00:00:00Z'), U('2026-01-01T00:00:00Z'));
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/End must not be earlier/);
  });
  it('rejects invalid dates', () => {
    expect(validateRange(NaN, 5).ok).toBe(false);
    expect(validateRange(fromInputValue('2026-13-45T99:00'), 5).ok).toBe(false);
    expect(validateRange(fromInputValue(''), 5).ok).toBe(false);
  });
  it('allows zero duration with a warning', () => {
    const v = validateRange(5, 5);
    expect(v.ok).toBe(true);
    expect(v.warnings[0]).toMatch(/single instant/);
  });
  it('rejects ranges fully outside dataset bounds and warns on partial overlap', () => {
    const bounds = { start: U('2026-03-01T00:00:00Z'), end: U('2026-07-31T00:00:00Z') };
    expect(validateRange(U('2025-01-01T00:00:00Z'), U('2025-02-01T00:00:00Z'), bounds).ok).toBe(false);
    const partial = validateRange(U('2026-02-01T00:00:00Z'), U('2026-04-01T00:00:00Z'), bounds);
    expect(partial.ok).toBe(true);
    expect(partial.warnings).toHaveLength(1);
  });
});

describe('time formatting', () => {
  it('parses datetime-local input as UTC (no local DST shifts)', () => {
    expect(fromInputValue('2026-03-08T02:30')).toBe(U('2026-03-08T02:30:00Z'));
  });
  it('formats month-scale ranges compactly', () => {
    expect(fmtRangeCompact(U('2026-01-01T00:00:00Z'), U('2026-06-30T00:00:00Z'))).toBe('Jan – Jun 2026');
  });
  it('formats short ranges with times', () => {
    expect(fmtRangeCompact(U('2026-11-14T10:00:00Z'), U('2026-11-14T12:30:00Z'))).toBe('Nov 14 10:00–12:30');
  });
});

describe('findGaps (irregular timestamps)', () => {
  const range = { start: U('2026-03-01T00:00:00Z'), end: U('2026-04-30T00:00:00Z') };
  it('marks intervals longer than 1.5x cadence, including trailing', () => {
    const o = obs([U('2026-03-04T00:00:00Z'), U('2026-03-16T00:00:00Z'), U('2026-04-09T00:00:00Z')]);
    expect(findGaps(o, range, 12 * DAY)).toEqual([
      { start: U('2026-03-16T00:00:00Z'), end: U('2026-04-09T00:00:00Z') },
      { start: U('2026-04-09T00:00:00Z'), end: range.end },
    ]);
  });
  it('treats an empty range as one gap', () => {
    expect(findGaps([], range, 12 * DAY)).toEqual([range]);
  });
});

describe('nearestObservationIndex', () => {
  const o = obs([0, 10, 25, 100]);
  it('finds the nearest real observation', () => {
    expect(nearestObservationIndex(o, -5)).toBe(0);
    expect(nearestObservationIndex(o, 16)).toBe(1);
    expect(nearestObservationIndex(o, 20)).toBe(2);
    expect(nearestObservationIndex(o, 1000)).toBe(3);
    expect(nearestObservationIndex([], 3)).toBe(-1);
  });
});
