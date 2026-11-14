import type { GeoBounds, LatLng } from '../../types';

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;

/**
 * A raster grid whose columns are uniform in longitude and whose rows are bounded by
 * explicit latitude edges (north → south). Supports Web-Mercator-aligned grids, so an
 * image of the grid overlays exactly on a Web-Mercator map.
 */
export interface GridSpec {
  cols: number;
  rows: number;
  west: number;
  east: number;
  /** rows + 1 latitude edges, from north (index 0) to south. */
  latEdges: Float64Array;
}

export function mercatorTileLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function mercatorTileLng(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

/** Grid aligned to Web-Mercator tiles: rows evenly spaced in Mercator Y. */
export function mercatorGrid(z: number, x0: number, y0: number, tilesX: number, tilesY: number, cellsPerTile: number): GridSpec {
  const cols = tilesX * cellsPerTile;
  const rows = tilesY * cellsPerTile;
  const latEdges = new Float64Array(rows + 1);
  for (let r = 0; r <= rows; r++) latEdges[r] = mercatorTileLat(y0 + r / cellsPerTile, z);
  return { cols, rows, west: mercatorTileLng(x0, z), east: mercatorTileLng(x0 + tilesX, z), latEdges };
}

export function gridBounds(g: GridSpec): GeoBounds {
  return { north: g.latEdges[0], south: g.latEdges[g.rows], west: g.west, east: g.east };
}

/** Geodesic (spherical) area of one cell in each row, km². */
export function rowCellAreasKm2(g: GridSpec): Float64Array {
  const dLng = toRad((g.east - g.west) / g.cols);
  const out = new Float64Array(g.rows);
  for (let r = 0; r < g.rows; r++) {
    out[r] = EARTH_RADIUS_KM ** 2 * dLng * Math.abs(Math.sin(toRad(g.latEdges[r])) - Math.sin(toRad(g.latEdges[r + 1])));
  }
  return out;
}

export function cellCenter(g: GridSpec, idx: number): LatLng {
  const r = Math.floor(idx / g.cols);
  const c = idx % g.cols;
  const lng = g.west + ((c + 0.5) * (g.east - g.west)) / g.cols;
  return [(g.latEdges[r] + g.latEdges[r + 1]) / 2, lng];
}

/** Bounds of a rectangular cell span [r0..r1] x [c0..c1] inclusive. */
export function spanBounds(g: GridSpec, r0: number, r1: number, c0: number, c1: number): GeoBounds {
  const w = (g.east - g.west) / g.cols;
  return { north: g.latEdges[r0], south: g.latEdges[r1 + 1], west: g.west + c0 * w, east: g.west + (c1 + 1) * w };
}

export function cellAt(g: GridSpec, [lat, lng]: LatLng): number {
  if (lng < g.west || lng >= g.east || lat > g.latEdges[0] || lat <= g.latEdges[g.rows]) return -1;
  const c = Math.floor(((lng - g.west) / (g.east - g.west)) * g.cols);
  // latEdges decreasing; binary search.
  let lo = 0;
  let hi = g.rows - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lat > g.latEdges[mid + 1]) hi = mid;
    else lo = mid + 1;
  }
  return lo * g.cols + c;
}

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function unionBounds(list: GeoBounds[]): GeoBounds | null {
  if (!list.length) return null;
  return list.reduce((a, b) => ({
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
  }));
}
