import type { LatLng } from '../../types';
import { SNAPSHOT_URL, boxAround } from './gibsSnapshots';

/**
 * Two ways to see which way a fire's smoke drifts:
 *  - observed: a loop of GOES geostationary GeoColor images (every 10 min from orbit) via NASA GIBS,
 *  - modelled: wind at 850 hPa (~1.5 km, where smoke is usually carried) from Open-Meteo.
 */
const HOUR = 36e5;
const MIN10 = 6e5;

/** GOES-West views the western US/Alaska, GOES-East the rest. */
export function goesLayer(lng: number): string {
  return lng < -105 ? 'GOES-West_ABI_GeoColor' : 'GOES-East_ABI_GeoColor';
}

/** Daylight frame times on a UTC day: local solar noon ± 4 h, every 30 min (aligned to GOES 10-min scans). */
export function goesTimes(lng: number, day: number): number[] {
  const noon = day + (12 - lng / 15) * HOUR;
  const out: number[] = [];
  for (let t = noon - 4 * HOUR; t <= noon + 4 * HOUR; t += HOUR / 2) out.push(Math.round(t / MIN10) * MIN10);
  return out;
}

export function goesUrl(at: LatLng, time: number, halfLatDeg: number, height: number): string {
  const b = boxAround(at, halfLatDeg);
  const width = Math.round((height * (b.east - b.west)) / (b.north - b.south));
  const p = new URLSearchParams({
    REQUEST: 'GetSnapshot',
    LAYERS: goesLayer(at[1]),
    CRS: 'EPSG:4326',
    TIME: new Date(time).toISOString().slice(0, 19) + 'Z',
    BBOX: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(4)).join(','),
    FORMAT: 'image/jpeg',
    WIDTH: String(width),
    HEIGHT: String(height),
  });
  return `${SNAPSHOT_URL}?${p}`;
}

export interface Wind {
  /** Meteorological direction the wind comes FROM (degrees, 0 = north). */
  fromDeg: number;
  /** Direction smoke is carried TOWARD (degrees, 0 = north). */
  towardDeg: number;
  speedKmh: number;
  time: number;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Model wind at 850 hPa at the fire, at the hour nearest local solar noon on that UTC day. */
export async function fetchWind([lat, lng]: LatLng, day: number, signal?: AbortSignal): Promise<Wind> {
  const date = new Date(day).toISOString().slice(0, 10);
  const p = new URLSearchParams({
    latitude: lat.toFixed(3), longitude: lng.toFixed(3), hourly: 'wind_direction_850hPa,wind_speed_850hPa',
    start_date: date, end_date: date, wind_speed_unit: 'kmh', timezone: 'GMT',
  });
  const r = await fetch(`https://historical-forecast-api.open-meteo.com/v1/forecast?${p}`, { signal });
  if (!r.ok) throw new Error(`Wind data unavailable (HTTP ${r.status})`);
  const j = (await r.json()) as { hourly?: { time: string[]; wind_direction_850hPa: (number | null)[]; wind_speed_850hPa: (number | null)[] } };
  const h = j.hourly;
  if (!h?.time?.length) throw new Error('No wind data for this day');
  const noonHour = Math.round(12 - lng / 15);
  const i = Math.min(h.time.length - 1, Math.max(0, ((noonHour % 24) + 24) % 24));
  const from = h.wind_direction_850hPa[i];
  const speed = h.wind_speed_850hPa[i];
  if (from == null || speed == null) throw new Error('No wind data for this hour');
  return { fromDeg: from, towardDeg: (from + 180) % 360, speedKmh: speed, time: Date.parse(`${h.time[i]}Z`) };
}
