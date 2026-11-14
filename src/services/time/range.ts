import type { Observation, TimeRange } from '../../types';
import { fmtDate } from './format';

export interface RangeValidation {
  ok: boolean;
  errors: string[];
  /** Non-blocking notes, e.g. partially outside the dataset bounds. */
  warnings: string[];
}

export function validateRange(start: number, end: number, bounds?: TimeRange): RangeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Number.isFinite(start)) errors.push('Start date/time is not valid.');
  if (!Number.isFinite(end)) errors.push('End date/time is not valid.');
  if (errors.length) return { ok: false, errors, warnings };
  if (end < start) errors.push('End must not be earlier than start.');
  if (bounds && !errors.length) {
    if (end < bounds.start || start > bounds.end) {
      errors.push(
        `This dataset only covers ${fmtDate(bounds.start)} – ${fmtDate(bounds.end)}; the selected range is entirely outside it.`,
      );
    } else if (start < bounds.start || end > bounds.end) {
      warnings.push(
        `Part of the range is outside the dataset coverage (${fmtDate(bounds.start)} – ${fmtDate(bounds.end)}); no observations exist there.`,
      );
    }
  }
  if (!errors.length && end === start) warnings.push('Zero-length range: the timeline will show a single instant.');
  return { ok: errors.length === 0, errors, warnings };
}

export interface DataGap {
  start: number;
  end: number;
}

/**
 * Intervals between consecutive observations longer than 1.5× the nominal cadence.
 * Also includes the leading/trailing parts of the range with no observation.
 */
export function findGaps(observations: Observation[], range: TimeRange, cadenceMs: number): DataGap[] {
  const gaps: DataGap[] = [];
  const limit = cadenceMs * 1.5;
  const times = observations.map((o) => o.time).filter((t) => t >= range.start && t <= range.end);
  if (!times.length) return range.end > range.start ? [{ start: range.start, end: range.end }] : [];
  if (times[0] - range.start > limit) gaps.push({ start: range.start, end: times[0] });
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > limit) gaps.push({ start: times[i - 1], end: times[i] });
  }
  const last = times[times.length - 1];
  if (range.end - last > limit) gaps.push({ start: last, end: range.end });
  return gaps;
}

/** Index of the observation nearest to `time` (observations sorted ascending). */
export function nearestObservationIndex(observations: Observation[], time: number): number {
  if (!observations.length) return -1;
  let lo = 0;
  let hi = observations.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (observations[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(observations[lo - 1].time - time) <= Math.abs(observations[lo].time - time)) return lo - 1;
  return lo;
}
