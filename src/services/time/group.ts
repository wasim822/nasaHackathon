import { DAY } from './format';

export function utcDayStart(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** Groups timestamped items into UTC days (ascending). */
export function groupByUtcDay<T>(items: T[], timeOf: (x: T) => number): { day: number; items: T[] }[] {
  const map = new Map<number, T[]>();
  for (const it of items) {
    const d = utcDayStart(timeOf(it));
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(it);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, xs]) => ({ day, items: xs.sort((a, b) => timeOf(a) - timeOf(b)) }));
}
