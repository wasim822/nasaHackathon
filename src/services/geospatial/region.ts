import type { GeoBounds, LatLng } from '../../types';

/**
 * Scope of the app for now: the United States and Canada.
 *
 * Queries use coarse bounding boxes (contiguous US + Canada, Alaska + Aleutians, Hawaii)
 * then drop points south of an approximate US–Mexico border line. This is a coarse
 * geographic filter, not an official boundary: events just offshore, or near the
 * Greenland/Caribbean edges, may be included or excluded imperfectly.
 */
export const REGION_NAME = 'United States & Canada';

export const REGION_BOXES: GeoBounds[] = [
  { south: 24.4, west: -141.0, north: 83.5, east: -52.0 }, // contiguous US + Canada
  { south: 50.5, west: -180.0, north: 72.0, east: -129.0 }, // Alaska + Aleutians
  { south: 51.0, west: 172.0, north: 53.5, east: 180.0 }, // western Aleutians (across 180°)
  { south: 18.5, west: -161.0, north: 22.6, east: -154.0 }, // Hawaii
];

export const REGION_VIEW = { center: [49, -100] as LatLng, zoom: 3 };

/**
 * How far the map may be panned / zoomed out: the region plus a margin (Gulf, Caribbean, Greenland),
 * so users stay over the US & Canada. The western Aleutians across 180° are outside it.
 */
export const REGION_MAX_BOUNDS: GeoBounds = { south: -30, west: -180, north: 85, east: -30 };
export const REGION_MIN_ZOOM = 3;

/** Approximate US–Mexico border, west → east (lng, lat). */
const MEXICO_BORDER: [number, number][] = [
  [-118.5, 32.4],
  [-117.12, 32.53],
  [-114.72, 32.72],
  [-114.81, 32.49],
  [-111.07, 31.33],
  [-108.21, 31.33],
  [-108.21, 31.78],
  [-106.53, 31.78],
  [-104.9, 30.6],
  [-104.0, 29.3],
  [-102.4, 29.8],
  [-101.4, 29.77],
  [-100.3, 28.2],
  [-99.5, 27.5],
  [-99.1, 26.4],
  [-97.15, 25.95],
  [-96.5, 25.9],
];

function borderLatAt(lng: number): number | null {
  if (lng < MEXICO_BORDER[0][0] || lng > MEXICO_BORDER[MEXICO_BORDER.length - 1][0]) return null;
  for (let i = 1; i < MEXICO_BORDER.length; i++) {
    const [x0, y0] = MEXICO_BORDER[i - 1];
    const [x1, y1] = MEXICO_BORDER[i];
    if (lng >= x0 && lng <= x1) return x1 === x0 ? Math.max(y0, y1) : y0 + ((lng - x0) / (x1 - x0)) * (y1 - y0);
  }
  return null;
}

const inBox = ([lat, lng]: LatLng, b: GeoBounds) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

export function isInRegion(p: LatLng): boolean {
  if (!REGION_BOXES.some((b) => inBox(p, b))) return false;
  const [lat, lng] = p;
  // Exclude Mexico and the Gulf of California south of the border line.
  const border = borderLatAt(lng);
  if (border != null && lat < border) return false;
  // Exclude Baja California / Pacific Mexico west of the border line's start.
  if (lng < -114 && lng > -125 && lat < 32.4) return false;
  return true;
}
