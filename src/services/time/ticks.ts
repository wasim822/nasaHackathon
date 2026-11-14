import { DAY, HOUR, MINUTE, fmtIso, fmtShortDate, fmtTime, monthName } from './format';

export const MAJOR_TICK_COUNT = 10;

export type TickScale = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'instant';

export interface Tick {
  index: number;
  /** Exact time this tick represents (UTC ms). */
  time: number;
  /** 0..1 position along the bar. */
  position: number;
  label: string;
  /** Exact timestamp for tooltips. */
  title: string;
}

export interface TickSet {
  ticks: Tick[];
  scale: TickScale;
  zeroDuration: boolean;
}

export function chooseScale(spanMs: number): TickScale {
  if (spanMs <= 0) return 'instant';
  const step = spanMs / (MAJOR_TICK_COUNT - 1);
  if (step >= 150 * DAY) return 'year';
  if (step >= 20 * DAY) return 'month';
  if (step >= 12 * HOUR) return 'day';
  if (step >= 30 * MINUTE) return 'hour';
  if (step >= 30 * 1000) return 'minute';
  return 'second';
}

const yearOf = (t: number) => new Date(t).getUTCFullYear();
const yy = (t: number) => `'${String(yearOf(t)).slice(2)}`;

function startOfNextMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Generates exactly ten evenly spaced major ticks spanning [start, end] inclusively.
 * Tick 1 is exactly `start`, tick 10 is exactly `end`. Labels adapt to the scale;
 * the exact timestamp is always available as `title`.
 *
 * Zero-duration ranges use an explicit single-instant strategy: ten ticks are still
 * rendered (evenly across the bar) but all represent the same instant and only the
 * first is labelled.
 */
export function generateTicks(start: number, end: number): TickSet {
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('Invalid range: non-finite time');
  if (end < start) throw new Error('Invalid range: end precedes start');
  const span = end - start;
  const scale = chooseScale(span);
  const n = MAJOR_TICK_COUNT;

  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    // Endpoints are exact; interior ticks evenly spaced in elapsed time.
    times.push(i === 0 ? start : i === n - 1 ? end : start + Math.round((span * i) / (n - 1)));
  }

  if (scale === 'instant') {
    return {
      scale,
      zeroDuration: true,
      ticks: times.map((time, i) => ({
        index: i,
        time,
        position: i / (n - 1),
        label: i === 0 ? `${fmtShortDate(time)} ${fmtTime(time)} (single instant)` : '',
        title: fmtIso(time),
      })),
    };
  }

  const labels = labelTicks(times, scale);
  return {
    scale,
    zeroDuration: false,
    ticks: times.map((time, i) => ({
      index: i,
      time,
      position: (time - start) / span,
      label: labels[i],
      title: fmtIso(time),
    })),
  };
}

function labelTicks(times: number[], scale: TickScale): string[] {
  const n = times.length;
  const labels: string[] = [];
  const multiYear = yearOf(times[0]) !== yearOf(times[n - 1]);

  if (scale === 'year') {
    for (const t of times) labels.push(`${monthName(t)} ${yearOf(t)}`);
    return dedupe(labels, times, (t) => fmtShortDate(t) + ` ${yearOf(t)}`);
  }

  if (scale === 'month') {
    const key = (x: number) => `${yearOf(x)}-${new Date(x).getUTCMonth()}`;
    let prevMonthKey = '';
    let prevYear = NaN;
    for (let i = 0; i < n; i++) {
      const t = times[i];
      let labelTime = t;
      // Interior ticks that fall just before a month boundary and would repeat the
      // previous month label are labelled with the upcoming month (≤3 days away).
      // Endpoints always keep their actual month. Exact time is in the tooltip.
      if (i > 0 && i < n - 1 && key(t) === prevMonthKey) {
        const next = startOfNextMonth(t);
        if (next - t <= 3 * DAY) labelTime = next;
      }
      prevMonthKey = key(labelTime);
      const y = yearOf(labelTime);
      const showYear = multiYear && y !== prevYear;
      prevYear = y;
      labels.push(showYear ? `${monthName(labelTime)} ${yy(labelTime)}` : monthName(labelTime));
    }
    return dedupe(labels, times, (t) => fmtShortDate(t));
  }

  if (scale === 'day') {
    for (const t of times) labels.push(fmtShortDate(t));
    return dedupe(labels, times, (t) => `${fmtShortDate(t)} ${fmtTime(t)}`);
  }

  // hour / minute / second: show the date on the first tick and whenever the UTC day changes.
  const seconds = scale === 'second';
  for (let i = 0; i < n; i++) {
    const t = times[i];
    const dayChanged = i === 0 || fmtShortDate(t) !== fmtShortDate(times[i - 1]);
    labels.push(dayChanged ? `${fmtShortDate(t)} ${fmtTime(t, seconds)}` : fmtTime(t, seconds));
  }
  return dedupe(labels, times, (t) => fmtTime(t, true));
}

/** Any label identical to its predecessor gets a more precise fallback. */
function dedupe(labels: string[], times: number[], precise: (t: number) => string): string[] {
  const out = [...labels];
  for (let i = 1; i < out.length; i++) {
    if (out[i] === out[i - 1] || out[i] === labels[i - 1]) out[i] = precise(times[i]);
  }
  return out;
}

/** 0..1 position of a time on the bar; zero-duration ranges place everything at 0.5. */
export function positionOf(time: number, start: number, end: number): number {
  if (end === start) return 0.5;
  return Math.min(1, Math.max(0, (time - start) / (end - start)));
}
