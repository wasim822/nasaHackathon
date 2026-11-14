import { generateTicks, MAJOR_TICK_COUNT, chooseScale } from './ticks';
import { DAY, HOUR, MINUTE } from './format';

const U = (iso: string) => Date.parse(iso);

describe('generateTicks — exact ten-tick rule', () => {
  const ranges: [string, number, number][] = [
    ['90 seconds', U('2026-11-14T10:00:00Z'), U('2026-11-14T10:01:30Z')],
    ['20 minutes', U('2026-11-14T10:00:00Z'), U('2026-11-14T10:20:00Z')],
    ['6 hours', U('2026-11-14T00:00:00Z'), U('2026-11-14T06:00:00Z')],
    ['3 days', U('2026-11-01T00:00:00Z'), U('2026-11-04T00:00:00Z')],
    ['30 days', U('2026-10-15T00:00:00Z'), U('2026-11-14T00:00:00Z')],
    ['Jan-Oct', U('2026-01-01T00:00:00Z'), U('2026-10-01T00:00:00Z')],
    ['5 years', U('2021-01-01T00:00:00Z'), U('2026-01-01T00:00:00Z')],
    ['irregular endpoints', U('2026-03-04T23:52:22Z'), U('2026-07-14T23:52:26Z')],
    ['across US DST change', U('2026-03-07T00:00:00Z'), U('2026-03-10T00:00:00Z')],
    ['leap-year February', U('2028-02-27T00:00:00Z'), U('2028-03-02T00:00:00Z')],
  ];

  it.each(ranges)('%s: exactly 10 ticks, exact endpoints, evenly spaced', (_name, start, end) => {
    const { ticks } = generateTicks(start, end);
    expect(ticks).toHaveLength(MAJOR_TICK_COUNT);
    expect(ticks[0].time).toBe(start);
    expect(ticks[9].time).toBe(end);
    expect(ticks[0].position).toBe(0);
    expect(ticks[9].position).toBe(1);
    const step = (end - start) / 9;
    ticks.forEach((t, i) => {
      expect(Math.abs(t.time - (start + step * i))).toBeLessThanOrEqual(1);
      expect(t.position).toBeCloseTo(i / 9, 6);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.title).toMatch(/UTC$/);
    });
  });

  it('labels Jan 1 - Oct 1 as a Jan..Oct progression', () => {
    const { ticks, scale } = generateTicks(U('2026-01-01T00:00:00Z'), U('2026-10-01T00:00:00Z'));
    expect(scale).toBe('month');
    expect(ticks.map((t) => t.label)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  });

  it('labels Jan 1 - Oct 31 as Jan..Oct without inventing Nov', () => {
    const { ticks } = generateTicks(U('2026-01-01T00:00:00Z'), U('2026-10-31T00:00:00Z'));
    expect(ticks.map((t) => t.label)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct']);
  });

  it('adapts the scale from years down to seconds', () => {
    expect(chooseScale(5 * 365 * DAY)).toBe('year');
    expect(chooseScale(270 * DAY)).toBe('month');
    expect(chooseScale(20 * DAY)).toBe('day');
    expect(chooseScale(12 * HOUR)).toBe('hour');
    expect(chooseScale(20 * MINUTE)).toBe('minute');
    expect(chooseScale(90 * 1000)).toBe('second');
  });

  it('never repeats adjacent labels', () => {
    const cases: [number, number][] = [
      [U('2026-01-01T00:00:00Z'), U('2026-01-03T00:00:00Z')],
      [U('2026-01-01T00:00:00Z'), U('2026-03-15T00:00:00Z')],
      [U('2026-11-14T10:00:00Z'), U('2026-11-14T10:05:00Z')],
      [U('2025-11-01T00:00:00Z'), U('2026-08-01T00:00:00Z')],
    ];
    for (const [start, end] of cases) {
      const labels = generateTicks(start, end).ticks.map((t) => t.label);
      for (let i = 1; i < labels.length; i++) expect(labels[i]).not.toBe(labels[i - 1]);
    }
  });

  it('shows the year when a month-scale range crosses a year boundary', () => {
    const labels = generateTicks(U('2025-11-01T00:00:00Z'), U('2026-08-01T00:00:00Z')).ticks.map((t) => t.label);
    expect(labels[0]).toBe("Nov '25");
    expect(labels.some((l) => l.includes("'26"))).toBe(true);
  });

  it('shows the date when hour-scale ticks cross midnight UTC', () => {
    const labels = generateTicks(U('2026-11-14T18:00:00Z'), U('2026-11-15T06:00:00Z')).ticks.map((t) => t.label);
    expect(labels[0]).toBe('Nov 14 18:00');
    expect(labels.some((l) => l.startsWith('Nov 15'))).toBe(true);
  });

  it('handles a zero-duration range with an explicit single-instant strategy', () => {
    const t = U('2026-11-14T12:00:00Z');
    const r = generateTicks(t, t);
    expect(r.zeroDuration).toBe(true);
    expect(r.ticks).toHaveLength(10);
    expect(r.ticks.every((x) => x.time === t && Number.isFinite(x.position))).toBe(true);
    expect(r.ticks[0].label).toContain('single instant');
  });

  it('rejects inverted or invalid ranges', () => {
    expect(() => generateTicks(10, 5)).toThrow();
    expect(() => generateTicks(NaN, 5)).toThrow();
  });
});
