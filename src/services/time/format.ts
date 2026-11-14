/**
 * All app times are displayed in UTC so ranges are consistent across viewer
 * time zones and daylight-saving transitions.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

export function monthName(t: number): string {
  return MONTHS[new Date(t).getUTCMonth()];
}

export function fmtDate(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export function fmtShortDate(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function fmtTime(t: number, seconds = false): string {
  const d = new Date(t);
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return seconds ? `${base}:${pad(d.getUTCSeconds())}` : base;
}

export function fmtDateTime(t: number): string {
  return `${fmtDate(t)} ${fmtTime(t)} UTC`;
}

/** Full ISO-like UTC string for tooltips. */
export function fmtIso(t: number): string {
  return new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** Value for <input type="datetime-local"> interpreted as UTC. */
export function toInputValue(t: number): string {
  return new Date(t).toISOString().slice(0, 16);
}

/** Parse <input type="datetime-local"> value as UTC. Returns NaN for invalid input. */
export function fromInputValue(v: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return NaN;
  const t = Date.parse(`${v.length === 16 ? `${v}:00` : v}Z`);
  return Number.isFinite(t) ? t : NaN;
}

/** Compact range label for the timeline, e.g. "Jan – Jun 2026" or "Nov 3 – 14". */
export function fmtRangeCompact(start: number, end: number): string {
  const a = new Date(start);
  const b = new Date(end);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  const span = end - start;
  if (span === 0) return `${fmtShortDate(start)} ${fmtTime(start)}`;
  if (span < 2 * DAY) {
    if (fmtShortDate(start) === fmtShortDate(end)) return `${fmtShortDate(start)} ${fmtTime(start)}–${fmtTime(end)}`;
    return `${fmtShortDate(start)} ${fmtTime(start)} – ${fmtShortDate(end)} ${fmtTime(end)}`;
  }
  if (span < 75 * DAY) {
    return sameYear
      ? `${fmtShortDate(start)} – ${fmtShortDate(end)}, ${b.getUTCFullYear()}`
      : `${fmtDate(start)} – ${fmtDate(end)}`;
  }
  return sameYear
    ? `${monthName(start)} – ${monthName(end)} ${b.getUTCFullYear()}`
    : `${monthName(start)} ${a.getUTCFullYear()} – ${monthName(end)} ${b.getUTCFullYear()}`;
}

export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs >= DAY) {
    const d = abs / DAY;
    return `${d >= 10 ? Math.round(d) : d.toFixed(1).replace(/\.0$/, '')} day${d === 1 ? '' : 's'}`;
  }
  if (abs >= HOUR) return `${(abs / HOUR).toFixed(1).replace(/\.0$/, '')} h`;
  if (abs >= MINUTE) return `${Math.round(abs / MINUTE)} min`;
  return `${Math.round(abs / 1000)} s`;
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
