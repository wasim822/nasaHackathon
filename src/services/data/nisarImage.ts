import type { GeoBounds, LatLng } from '../../types';
import type { NisarScene } from './nisar';

/** Pixels darker than this (mean RGB) are treated as "no data" background. */
export const DARK_THRESHOLD = 12;
const MAX_DIM = 1400;

export interface Registration {
  bounds: GeoBounds;
  method: 'kml' | 'footprint-fit';
  /** Largest disagreement between fitted image and footprint vertices, in pixels. */
  residualPx: number;
}

/**
 * Registers a north-up lat/lon browse image without a georeference file.
 * The extreme valid pixels (left-, right-, top-, bottom-most) of a rotated swath
 * correspond to the footprint's west-, east-, north-, south-most vertices; a linear
 * fit per axis gives the image's geographic bounds. Residuals on the other axis are
 * reported so poor fits can be rejected.
 */
export function registerFromFootprint(rgba: Uint8ClampedArray, w: number, h: number, footprint: LatLng[], threshold = DARK_THRESHOLD): Registration | null {
  let minX: [number, number] | null = null, maxX: [number, number] | null = null;
  let minY: [number, number] | null = null, maxY: [number, number] | null = null;
  const t3 = threshold * 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (rgba[o + 3] === 0 || rgba[o] + rgba[o + 1] + rgba[o + 2] <= t3) continue;
      if (!minX || x < minX[0]) minX = [x, y];
      if (!maxX || x > maxX[0]) maxX = [x, y];
      if (!minY || y < minY[1]) minY = [x, y];
      if (!maxY || y > maxY[1]) maxY = [x, y];
    }
  }
  if (!minX || !maxX || !minY || !maxY || footprint.length < 3) return null;
  const pts = footprint.slice(0, footprint.length > 3 && footprint[0][0] === footprint[footprint.length - 1][0] && footprint[0][1] === footprint[footprint.length - 1][1] ? -1 : undefined);
  const west = pts.reduce((a, p) => (p[1] < a[1] ? p : a));
  const east = pts.reduce((a, p) => (p[1] > a[1] ? p : a));
  const north = pts.reduce((a, p) => (p[0] > a[0] ? p : a));
  const south = pts.reduce((a, p) => (p[0] < a[0] ? p : a));
  const dx = maxX[0] - minX[0];
  const dy = maxY[1] - minY[1];
  if (dx < 4 || dy < 4) return null;
  const ax = (east[1] - west[1]) / dx; // degrees lon per px
  const lon0 = west[1] - ax * minX[0];
  const ay = (south[0] - north[0]) / dy; // degrees lat per px (negative)
  const lat0 = north[0] - ay * minY[1];
  const residualPx = Math.max(
    Math.abs((west[0] - lat0) / ay - minX[1]),
    Math.abs((east[0] - lat0) / ay - maxX[1]),
    Math.abs((north[1] - lon0) / ax - minY[0]),
    Math.abs((south[1] - lon0) / ax - maxY[0]),
  );
  return {
    bounds: { west: lon0, east: lon0 + ax * w, north: lat0, south: lat0 + ay * h },
    method: 'footprint-fit',
    residualPx,
  };
}

/** Parses LatLonQuad / LatLonBox bounds from a browse KML. */
export function boundsFromKml(kml: string): GeoBounds | null {
  const quad = kml.match(/<coordinates>([^<]+)<\/coordinates>/);
  if (quad) {
    const pts = quad[1].trim().split(/\s+/).map((p) => p.split(',').map(Number));
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    if (lons.every(Number.isFinite) && lats.every(Number.isFinite) && pts.length >= 4) {
      return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
    }
  }
  const tag = (n: string) => Number(kml.match(new RegExp(`<${n}>([^<]+)</${n}>`))?.[1]);
  const box = { north: tag('north'), south: tag('south'), east: tag('east'), west: tag('west') };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y: number) => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

export interface ProcessedImage {
  url: string;
  bounds: GeoBounds;
  registration: Registration;
}

/**
 * Downloads a browse PNG, georegisters it, makes the black background transparent and
 * resamples rows from lat/lon to Web-Mercator so it overlays exactly on the map.
 */
export async function processSceneImage(scene: NisarScene, signal: AbortSignal, url = scene.browseUrl): Promise<ProcessedImage> {
  const [blob, kml] = await Promise.all([
    fetch(url, { signal }).then((r) => {
      if (!r.ok) throw new Error(`Browse image HTTP ${r.status}`);
      return r.blob();
    }),
    scene.kmlUrl ? fetch(scene.kmlUrl, { signal }).then((r) => (r.ok ? r.text() : null)).catch(() => null) : Promise.resolve(null),
  ]);
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  if (!sctx) throw new Error('Canvas unavailable');
  sctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const img = sctx.getImageData(0, 0, w, h);

  let registration: Registration | null = null;
  const kmlBounds = kml ? boundsFromKml(kml) : null;
  if (kmlBounds) registration = { bounds: kmlBounds, method: 'kml', residualPx: 0 };
  else registration = registerFromFootprint(img.data, w, h, scene.footprint);
  if (!registration) throw new Error('Could not georeference browse image');
  if (registration.residualPx > Math.max(w, h) * 0.02) throw new Error(`Georeferencing too uncertain (${registration.residualPx.toFixed(0)} px)`);

  // Transparent background.
  const d = img.data;
  const t3 = DARK_THRESHOLD * 3;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] <= t3) d[i + 3] = 0;
  sctx.putImageData(img, 0, 0);

  // Lat/lon rows → Web-Mercator rows.
  const { north, south } = registration.bounds;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas unavailable');
  const yN = mercY(north);
  const yS = mercY(south);
  for (let j = 0; j < h; j++) {
    const lat = invMercY(yN + ((j + 0.5) / h) * (yS - yN));
    const sr = Math.min(h - 1, Math.max(0, Math.floor(((north - lat) / (north - south)) * h)));
    octx.drawImage(src, 0, sr, w, 1, 0, j, w, 1);
  }
  const outBlob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
  if (!outBlob) throw new Error('Image encoding failed');
  return { url: URL.createObjectURL(outBlob), bounds: registration.bounds, registration };
}
