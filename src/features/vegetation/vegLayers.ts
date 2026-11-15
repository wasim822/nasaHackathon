/**
 * Which NASA GIBS vegetation maps to stack for a chosen date, newest on top.
 *
 * - VIIRS NOAA-20 L3 NDVI 16-day composites (science quality): a new composite every 8 days, each
 *   starting on Jan 1 + 8k days of its year, covering the 16 days from its start. 2018 → L3_LAST.
 * - VIIRS NOAA-20 NDVI 8-day (near real time): a rolling 8-day composite for every day, used after
 *   L3_LAST, when the science product isn't out yet.
 *
 * The top map is the period containing the chosen date; older periods are stacked underneath so
 * their pixels fill holes (clouds, snow, no pass) in newer ones, going back at most MAX_LOOKBACK.
 */
const DAY = 864e5;
export const L3_LAYER = 'VIIRS_NOAA20_L3_NDVI_16Day';
export const NRT_LAYER = 'VIIRS_NOAA20_NDVI_8Day';
export const LANDCOVER_LAYER = 'MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual';
export const L3_FIRST = Date.UTC(2018, 0, 1);
export const L3_LAST = Date.UTC(2026, 9, 24);
export const NRT_FIRST = Date.UTC(2025, 8, 22);
export const LANDCOVER_YEARS = [2001, 2024] as const;
export const MAX_LOOKBACK_DAYS = 40;
const MAX_LAYERS = 6;

export interface VegLayer {
  layer: string;
  /** GIBS TIME value (YYYY-MM-DD): composite start (L3) or composite day (NRT). */
  date: string;
  /** Data period this map summarises (UTC ms, inclusive start, exclusive end). */
  from: number;
  to: number;
}

export const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const utcDay = (t: number) => Math.floor(t / DAY) * DAY;

/** Start of the L3 16-day composite whose start is the latest one on or before `t`. */
export function l3Start(t: number): number {
  const y = new Date(t).getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  const k = Math.floor((utcDay(t) - jan1) / (8 * DAY));
  return Math.min(jan1 + Math.min(k, 45) * 8 * DAY, Date.UTC(y, 11, 27));
}

/** Maps to stack for a chosen date, newest first. */
export function vegLayersFor(date: number): VegLayer[] {
  const day = utcDay(date);
  const limit = day - MAX_LOOKBACK_DAYS * DAY;
  const out: VegLayer[] = [];
  let t = day;
  while (out.length < MAX_LAYERS && t >= limit && t >= L3_FIRST) {
    if (t > L3_LAST && t >= NRT_FIRST) {
      out.push({ layer: NRT_LAYER, date: isoDay(t), from: t - 7 * DAY, to: t + DAY });
      t -= 8 * DAY;
      continue;
    }
    const s = l3Start(Math.min(t, L3_LAST));
    if (s < limit) break;
    out.push({ layer: L3_LAYER, date: isoDay(s), from: s, to: s + 16 * DAY });
    t = s - DAY;
  }
  return out;
}

export function landCoverYear(date: number): number {
  return Math.min(LANDCOVER_YEARS[1], Math.max(LANDCOVER_YEARS[0], new Date(date).getUTCFullYear()));
}

export function gibsTileUrl(layer: string, date: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`;
}
